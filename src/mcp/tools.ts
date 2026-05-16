import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeCodeAgentOptions } from "../agents/ClaudeCodeAgent.js";
import { ClaudeCodeAgent } from "../agents/ClaudeCodeAgent.js";
import type { Stage, StageResult } from "../types.js";

export interface ClaudeRunStageArgs {
  stage: Stage;
  workspace: string;
  request: string;
  runId?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
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

function validateArgs(args: ClaudeRunStageArgs): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.request) return "request is required";
  if (!isStage(args.stage)) return `invalid stage: ${String(args.stage)}`;
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
