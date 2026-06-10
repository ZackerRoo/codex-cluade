#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudeCodeAgent } from "./agents/ClaudeCodeAgent.js";
import { CodexCliAgent, GeminiCliAgent, MyFlickerAgent, OpenCodeAgent } from "./agents/CliCodeAgent.js";
import { CodexAgent } from "./agents/CodexAgent.js";
import { loadBridgeConfig } from "./config/BridgeConfig.js";
import { defaultCodexConfigPath, setupCodexMcpConfig } from "./config/CodexSetup.js";
import { runInstallDoctor } from "./install/InstallDoctor.js";
import type { AgentName, Stage } from "./types.js";
import { printJson } from "./utils/json.js";
import { verifyWebApp, type WebAppExpectation } from "./verification/WebAppVerifier.js";
import { AgentCoordinator } from "./workflow/AgentCoordinator.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === "setup-codex") {
    await runSetupCodex(rest);
    return;
  }

  if (command === "doctor") {
    await runDoctor(rest);
    return;
  }

  if (command === "verify-web") {
    await runVerifyWeb(rest);
    return;
  }

  if (command !== "run-stage") {
    throw new Error(`Unknown command: ${command ?? ""}. Expected run-stage, setup-codex, doctor, or verify-web.`);
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
      myflicker: new MyFlickerAgent(),
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

async function runVerifyWeb(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      workspace: { type: "string" },
      entry: { type: "string" },
      expect: { type: "string", multiple: true },
      "min-body-text": { type: "string" }
    }
  });
  const workspace = resolve(required(values.workspace, "--workspace"));
  const expectations = parseExpectations(values.expect);
  const minBodyTextLength = values["min-body-text"] ? Number(values["min-body-text"]) : undefined;
  if (minBodyTextLength !== undefined && (!Number.isFinite(minBodyTextLength) || minBodyTextLength < 0)) {
    throw new Error("--min-body-text must be a non-negative number");
  }
  const result = await verifyWebApp({
    workspace,
    entry: values.entry,
    expectations,
    minBodyTextLength
  });
  printJson({
    command: "verify-web",
    ...result
  });
  if (!result.ok) process.exitCode = 1;
}

async function runDoctor(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      "bridge-config": { type: "string" },
      "timeout-ms": { type: "string" }
    }
  });
  const timeoutMs = values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive number");
  }
  const env = values["bridge-config"]
    ? { ...process.env, CODEX_CLAUDE_CONFIG: values["bridge-config"] }
    : process.env;
  const result = await runInstallDoctor({
    codexConfigPath: values.config ?? defaultCodexConfigPath(),
    bridgeConfig: loadBridgeConfig(process.cwd(), env),
    env,
    timeoutMs
  });
  printJson({
    command: "doctor",
    ...result
  });
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
      "opencode-path": { type: "string" },
      "myflicker-path": { type: "string" }
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
    opencodePath: values["opencode-path"],
    myflickerPath: values["myflicker-path"]
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

function parseExpectations(value: string[] | string | boolean | undefined): WebAppExpectation[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return items.map(item => {
    const marker = item.lastIndexOf(">=");
    if (marker <= 0) throw new Error(`Invalid --expect value: ${item}. Expected selector>=count`);
    const selector = item.slice(0, marker).trim();
    const minCount = Number(item.slice(marker + 2).trim());
    if (!selector || !Number.isInteger(minCount) || minCount < 0) {
      throw new Error(`Invalid --expect value: ${item}. Expected selector>=count`);
    }
    return { selector, minCount };
  });
}

function parseStage(value: string): Stage {
  if (value === "plan" || value === "implement" || value === "review" || value === "analyze") {
    return value;
  }
  throw new Error(`Invalid stage: ${value}`);
}

function parseAgent(value: string): AgentName {
  if (value === "claude" || value === "codex" || value === "codex-cli" || value === "gemini" || value === "opencode" || value === "myflicker") return value;
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
