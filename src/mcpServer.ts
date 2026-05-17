#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createTaskTools, runClaudeStageTool } from "./mcp/tools.js";

const stageSchema = z.enum(["plan", "implement", "review", "analyze"]);
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]).optional();
const agentSchema = z.enum(["claude", "codex"]).optional();
const modeSchema = z.enum(["sync", "background"]).optional();

export function createServer(): McpServer {
  const server = new McpServer({
    name: "claude-agent-bridge",
    version: "0.1.0"
  });
  const taskTools = createTaskTools();

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

  server.registerTool(
    "delegate_task",
    {
      title: "Delegate task",
      description:
        "Route one or more stages to Codex or Claude by preferred agent or category. Supports sync and background modes.",
      inputSchema: {
        mode: modeSchema.describe("sync waits for completion; background returns a task id."),
        stage: stageSchema.optional().describe("Single stage to run. Use stages for multi-stage workflows."),
        stages: z.array(stageSchema).optional().describe("Ordered stages to run."),
        workspace: z.string().min(1).describe("Absolute workspace path where the task should run."),
        request: z.string().min(1).describe("User request or task prompt."),
        category: z.string().optional().describe("Routing category such as planning, coding, review, analysis, fast, or heavy."),
        preferredAgent: agentSchema.describe("Explicit agent override."),
        runId: z.string().optional().describe("Optional run id for artifacts and task tracking."),
        model: z.string().optional().describe("Optional model argument for compatible providers."),
        effort: effortSchema.describe("Optional effort level."),
        timeoutMs: z.number().positive().optional().describe("Optional timeout in milliseconds.")
      },
      annotations: {
        title: "Delegate task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.delegateTaskTool(args)
  );

  server.registerTool(
    "task_status",
    {
      title: "Task status",
      description: "Read status and result metadata for a background delegated task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id returned by delegate_task.")
      },
      annotations: {
        title: "Task status",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.taskStatusTool(args)
  );

  server.registerTool(
    "task_cancel",
    {
      title: "Cancel task",
      description: "Cancel a running background delegated task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id returned by delegate_task.")
      },
      annotations: {
        title: "Cancel task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.taskCancelTool(args)
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
