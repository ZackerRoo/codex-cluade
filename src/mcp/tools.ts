import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeCodeAgentOptions } from "../agents/ClaudeCodeAgent.js";
import { ClaudeCodeAgent } from "../agents/ClaudeCodeAgent.js";
import { CodexAgent } from "../agents/CodexAgent.js";
import type { AgentName, Stage, StageResult, TaskCategory, TaskMode } from "../types.js";
import { AgentCoordinator } from "../workflow/AgentCoordinator.js";
import { TaskManager } from "../workflow/TaskManager.js";

export interface ClaudeRunStageArgs {
  stage: Stage;
  workspace: string;
  request: string;
  runId?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface DelegateTaskArgs {
  mode?: TaskMode;
  stages?: Stage[];
  stage?: Stage;
  workspace: string;
  request: string;
  category?: TaskCategory;
  preferredAgent?: AgentName;
  runId?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface TaskLookupArgs {
  taskId: string;
}

export interface TaskToolSet {
  delegateTaskTool(args: DelegateTaskArgs): Promise<CallToolResult>;
  taskStatusTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskCancelTool(args: TaskLookupArgs): Promise<CallToolResult>;
}

export async function runClaudeStageTool(
  args: ClaudeRunStageArgs,
  options: ClaudeCodeAgentOptions = {}
): Promise<CallToolResult> {
  const validationError = validateArgs(args);
  if (validationError) return errorResult(validationError);

  try {
    const agent = new ClaudeCodeAgent({
      claudePath: process.env.CLAUDE_CODE_PATH,
      ...options
    });
    const result = await agent.run({
      stage: args.stage,
      agent: "claude",
      workspace: args.workspace,
      request: args.request,
      runId: args.runId,
      model: args.model,
      effort: args.effort,
      timeoutMs: args.timeoutMs
    });

    return {
      content: [
        {
          type: "text",
          text: formatStageResult(result)
        }
      ],
      structuredContent: { ...result },
      isError: result.ok ? undefined : true
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

export function createTaskTools(options: { claude?: ClaudeCodeAgentOptions } = {}): TaskToolSet {
  const coordinator = new AgentCoordinator({
    providers: {
      claude: new ClaudeCodeAgent({
        claudePath: process.env.CLAUDE_CODE_PATH,
        ...options.claude
      }),
      codex: new CodexAgent()
    }
  });
  const manager = new TaskManager(coordinator);

  return {
    async delegateTaskTool(args: DelegateTaskArgs): Promise<CallToolResult> {
      const validationError = validateDelegateArgs(args);
      if (validationError) return errorResult(validationError);

      try {
        const stages = args.stages ?? (args.stage ? [args.stage] : ["plan"]);
        const result = await manager.run({
          mode: args.mode ?? "sync",
          workspace: args.workspace,
          request: args.request,
          stages,
          routing: {},
          category: args.category,
          preferredAgent: args.preferredAgent,
          runId: args.runId,
          model: args.model,
          effort: args.effort,
          timeoutMs: args.timeoutMs
        });
        return {
          content: [{ type: "text", text: formatDelegateResult(result) }],
          structuredContent: {
            ok: result.mode === "sync" ? result.result?.ok === true : true,
            ...result
          },
          isError: result.mode === "sync" && result.result?.ok === false ? true : undefined
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },

    async taskStatusTool(args: TaskLookupArgs): Promise<CallToolResult> {
      if (!args.taskId) return errorResult("taskId is required");
      const task = manager.get(args.taskId);
      if (!task) return errorResult(`Task not found: ${args.taskId}`);
      return {
        content: [{ type: "text", text: formatTask(task) }],
        structuredContent: { ok: true, ...task }
      };
    },

    async taskCancelTool(args: TaskLookupArgs): Promise<CallToolResult> {
      if (!args.taskId) return errorResult("taskId is required");
      const task = manager.cancel(args.taskId);
      if (!task) return errorResult(`Task not found: ${args.taskId}`);
      return {
        content: [{ type: "text", text: formatTask(task) }],
        structuredContent: { ok: true, ...task }
      };
    }
  };
}

function validateArgs(args: ClaudeRunStageArgs): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.request) return "request is required";
  if (!isStage(args.stage)) return `invalid stage: ${String(args.stage)}`;
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  return undefined;
}

function validateDelegateArgs(args: DelegateTaskArgs): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.request) return "request is required";
  if (args.mode !== undefined && args.mode !== "sync" && args.mode !== "background") {
    return `invalid mode: ${String(args.mode)}`;
  }
  const stages = args.stages ?? (args.stage ? [args.stage] : ["plan"]);
  if (stages.length === 0) return "at least one stage is required";
  for (const stage of stages) {
    if (!isStage(stage)) return `invalid stage: ${String(stage)}`;
  }
  if (args.preferredAgent !== undefined && args.preferredAgent !== "claude" && args.preferredAgent !== "codex") {
    return `invalid preferredAgent: ${String(args.preferredAgent)}`;
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  return undefined;
}

function isStage(value: unknown): value is Stage {
  return value === "plan" || value === "implement" || value === "review" || value === "analyze";
}

function formatStageResult(result: StageResult): string {
  const lines = [
    result.summary,
    `Run: ${result.runId}`,
    `Stage: ${result.stage}`,
    `Status: ${result.status}`
  ];

  if (result.outputPath) lines.push(`Output: ${result.outputPath}`);
  if (result.logPath) lines.push(`Log: ${result.logPath}`);
  if (result.changedFiles.length > 0) lines.push(`Changed files: ${result.changedFiles.join(", ")}`);
  if (result.error) lines.push(`Error: ${result.error}`);

  return lines.join("\n");
}

function formatDelegateResult(result: Awaited<ReturnType<TaskManager["run"]>>): string {
  if (result.mode === "background") {
    return [
      "Background task launched",
      `Task: ${result.taskId}`,
      `Status: ${result.task?.status ?? "pending"}`,
      result.task?.runId ? `Run: ${result.task.runId}` : undefined
    ].filter(Boolean).join("\n");
  }
  return [
    "Synchronous task completed",
    `Run: ${result.result?.runId}`,
    `Status: ${result.result?.ok ? "completed" : "failed"}`,
    result.result?.summary
  ].filter(Boolean).join("\n");
}

function formatTask(task: { id: string; status: string; runId: string; updatedAt: string; error?: string }): string {
  return [
    `Task: ${task.id}`,
    `Run: ${task.runId}`,
    `Status: ${task.status}`,
    `Updated: ${task.updatedAt}`,
    task.error ? `Error: ${task.error}` : undefined
  ].filter(Boolean).join("\n");
}

function errorResult(message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    structuredContent: {
      ok: false,
      error: message
    },
    isError: true
  };
}
