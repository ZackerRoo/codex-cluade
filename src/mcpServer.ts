#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createTaskTools, runClaudeStageTool, type TaskToolSet } from "./mcp/tools.js";

const stageSchema = z.enum(["plan", "implement", "review", "analyze"]);
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]).optional();
const agentSchema = z.enum(["claude", "codex"]).optional();
const modeSchema = z.enum(["sync", "background"]).optional();

export function createServer(options: { taskTools?: TaskToolSet } = {}): McpServer {
  const server = new McpServer({
    name: "claude-agent-bridge",
    version: "0.1.0"
  });
  const taskTools = options.taskTools ?? createTaskTools();

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
        agentSessionId: z.string().optional().describe("Optional Claude session id to resume."),
        loadSkills: z.array(z.string()).optional().describe("Configured skill names to inject into the delegated prompt."),
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
        profile: z.string().optional().describe("Named routing profile such as planner, coder, reviewer, analyst, quick, or heavy-coder."),
        autoCategory: z.boolean().optional().describe("Infer a category from the request when category/profile/preferredAgent are omitted."),
        preferredAgent: agentSchema.describe("Explicit agent override."),
        runId: z.string().optional().describe("Optional run id for artifacts and task tracking."),
        agentSessionId: z.string().optional().describe("Optional Claude session id to resume when a Claude stage runs."),
        loadSkills: z.array(z.string()).optional().describe("Configured skill names to inject into the delegated prompt."),
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
    "create_plan",
    {
      title: "Create plan",
      description: "Generate a markdown implementation plan and save it under the workspace .codex-claude/plans directory.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute workspace path where the plan belongs."),
        request: z.string().min(1).describe("User request to plan."),
        planId: z.string().optional().describe("Optional plan id. Defaults to a generated id."),
        plannerProfile: z.string().optional().describe("Optional planner profile. Defaults to Claude when omitted."),
        preferredAgent: agentSchema.describe("Optional planner agent override."),
        loadSkills: z.array(z.string()).optional().describe("Configured skill names to inject into the planning prompt."),
        model: z.string().optional().describe("Optional model argument for compatible providers."),
        effort: effortSchema.describe("Optional effort level."),
        timeoutMs: z.number().positive().optional().describe("Optional timeout in milliseconds.")
      },
      annotations: {
        title: "Create plan",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.createPlanTool(args)
  );

  server.registerTool(
    "execute_plan",
    {
      title: "Execute plan",
      description: "Read a saved markdown plan and delegate implementation to an executor agent.",
      inputSchema: {
        mode: modeSchema.describe("sync waits for completion; background returns a task id."),
        workspace: z.string().min(1).describe("Absolute workspace path where the plan should execute."),
        planId: z.string().optional().describe("Plan id under .codex-claude/plans."),
        planPath: z.string().optional().describe("Absolute or workspace-relative plan path."),
        request: z.string().optional().describe("Optional extra instruction to append to the execution prompt."),
        executorProfile: z.string().optional().describe("Optional executor profile. Defaults to coder."),
        preferredAgent: agentSchema.describe("Optional executor agent override."),
        runId: z.string().optional().describe("Optional run id for artifacts and task tracking."),
        agentSessionId: z.string().optional().describe("Optional Claude session id to resume when a Claude stage runs."),
        loadSkills: z.array(z.string()).optional().describe("Configured skill names to inject into the execution prompt."),
        model: z.string().optional().describe("Optional model argument for compatible providers."),
        effort: effortSchema.describe("Optional effort level."),
        timeoutMs: z.number().positive().optional().describe("Optional timeout in milliseconds.")
      },
      annotations: {
        title: "Execute plan",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.executePlanTool(args)
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
    "background_output",
    {
      title: "Background output",
      description: "Read task artifacts, Claude logs, and transcript tail for a background delegated task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id returned by delegate_task."),
        maxBytes: z.number().positive().optional().describe("Maximum bytes to read from each output/log file."),
        cursor: z.number().nonnegative().optional().describe("Incremental output cursor returned by the previous background_output call.")
      },
      annotations: {
        title: "Background output",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.backgroundOutputTool(args)
  );

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "List background delegated tasks tracked by the current MCP server process.",
      inputSchema: {},
      annotations: {
        title: "List tasks",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => taskTools.taskListTool()
  );

  server.registerTool(
    "agent_catalog",
    {
      title: "Agent catalog",
      description: "List available agents, routing categories, and named delegation profiles.",
      inputSchema: {},
      annotations: {
        title: "Agent catalog",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => taskTools.agentCatalogTool()
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

  server.registerTool(
    "task_retry",
    {
      title: "Retry task",
      description: "Start a fresh background retry from a previous delegated task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id to retry.")
      },
      annotations: {
        title: "Retry task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.taskRetryTool(args)
  );

  server.registerTool(
    "task_resume",
    {
      title: "Resume task",
      description: "Start a background retry that resumes the latest Claude session from a previous task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id to resume from.")
      },
      annotations: {
        title: "Resume task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.taskResumeTool(args)
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
