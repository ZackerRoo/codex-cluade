#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runClaudeStageTool } from "./mcp/tools.js";

const stageSchema = z.enum(["plan", "implement", "review", "analyze"]);
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]).optional();

export function createServer(): McpServer {
  const server = new McpServer({
    name: "claude-agent-bridge",
    version: "0.1.0"
  });

  server.registerTool(
    "claude_run_stage",
    {
      title: "Run Claude Code stage",
      description:
        "Delegate a plan, implement, review, or analyze stage to the local Claude Code CLI and return the captured result.",
      inputSchema: {
        stage: stageSchema.describe("Stage to run with Claude Code."),
        workspace: z.string().min(1).describe("Absolute workspace path where Claude Code should run."),
        request: z.string().min(1).describe("User request or stage prompt to send to Claude Code."),
        runId: z.string().optional().describe("Optional run id for .agent-runs artifacts."),
        model: z.string().optional().describe("Optional Claude model argument."),
        effort: effortSchema.describe("Optional Claude effort level."),
        timeoutMs: z.number().positive().optional().describe("Optional timeout in milliseconds.")
      },
      annotations: {
        title: "Run Claude Code stage",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => runClaudeStageTool(args)
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
