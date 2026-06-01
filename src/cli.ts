#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudeCodeAgent } from "./agents/ClaudeCodeAgent.js";
import { CodexCliAgent, GeminiCliAgent, OpenCodeAgent } from "./agents/CliCodeAgent.js";
import { CodexAgent } from "./agents/CodexAgent.js";
import { defaultCodexConfigPath, setupCodexMcpConfig } from "./config/CodexSetup.js";
import type { AgentName, Stage } from "./types.js";
import { printJson } from "./utils/json.js";
import { AgentCoordinator } from "./workflow/AgentCoordinator.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === "setup-codex") {
    await runSetupCodex(rest);
    return;
  }

  if (command !== "run-stage") {
    throw new Error(`Unknown command: ${command ?? ""}. Expected run-stage or setup-codex.`);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      stage: { type: "string" },
      agent: { type: "string" },
      workspace: { type: "string" },
      "request-file": { type: "string" },
      "run-id": { type: "string" },
      "agent-session-id": { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "timeout-ms": { type: "string" }
    }
  });

  const stage = parseStage(required(values.stage, "--stage"));
  const agent = parseAgent(required(values.agent, "--agent"));
  const workspace = resolve(required(values.workspace, "--workspace"));
  const requestFile = resolve(required(values["request-file"], "--request-file"));
  const request = await readFile(requestFile, "utf8");
  const timeoutMs = values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined;

  if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
    throw new Error("--timeout-ms must be a number");
  }

  const coordinator = new AgentCoordinator({
    providers: {
      claude: new ClaudeCodeAgent(),
      "codex-cli": new CodexCliAgent(),
      gemini: new GeminiCliAgent(),
      opencode: new OpenCodeAgent(),
      codex: new CodexAgent()
    }
  });

  const result = await coordinator.run({
    workspace,
    request,
    stages: [stage],
    routing: { [stage]: agent },
    runId: values["run-id"],
    agentSessionId: values["agent-session-id"],
    model: values.model,
    effort: parseEffort(values.effort),
    timeoutMs
  });

  printJson(result.results[0]);
}

async function runSetupCodex(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      write: { type: "boolean", default: false },
      port: { type: "string" },
      "server-path": { type: "string" },
      "claude-path": { type: "string" },
      "codex-path": { type: "string" },
      "gemini-path": { type: "string" },
      "opencode-path": { type: "string" }
    }
  });

  const port = values.port ? Number(values.port) : 8787;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("--port must be a positive integer");
  }

  const result = await setupCodexMcpConfig({
    configPath: values.config ?? defaultCodexConfigPath(),
    serverPath: values["server-path"] ?? defaultDashboardServerPath(),
    port,
    write: Boolean(values.write),
    claudePath: values["claude-path"],
    codexPath: values["codex-path"],
    geminiPath: values["gemini-path"],
    opencodePath: values["opencode-path"]
  });

  printJson({
    ok: true,
    command: "setup-codex",
    configPath: result.configPath,
    written: result.written,
    content: result.content
  });
}

function defaultDashboardServerPath(): string {
  return fileURLToPath(new URL("./mcpDashboardServer.js", import.meta.url));
}

function required(value: string | boolean | undefined, flag: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Missing required option ${flag}`);
}

function parseStage(value: string): Stage {
  if (value === "plan" || value === "implement" || value === "review" || value === "analyze") {
    return value;
  }
  throw new Error(`Invalid stage: ${value}`);
}

function parseAgent(value: string): AgentName {
  if (value === "claude" || value === "codex" || value === "codex-cli" || value === "gemini" || value === "opencode") return value;
  throw new Error(`Invalid agent: ${value}`);
}

function parseEffort(value: string | boolean | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value;
  }
  throw new Error(`Invalid effort: ${String(value)}`);
}

main(process.argv.slice(2)).catch(error => {
  printJson({
    ok: false,
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
