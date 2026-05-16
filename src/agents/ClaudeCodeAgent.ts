import type { AgentProvider } from "./AgentProvider.js";
import type { StageInput, StageResult } from "../types.js";
import { buildStagePrompt } from "../prompts/stagePrompts.js";
import { ResultStore } from "../storage/ResultStore.js";
import { execFileCapture, type ExecResult } from "../utils/exec.js";
import { changedFiles } from "../utils/git.js";

type ExecFn = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; input?: string }
) => Promise<ExecResult>;

export interface ClaudeCodeAgentOptions {
  claudePath?: string;
  exec?: ExecFn;
  getChangedFiles?: (workspace: string) => Promise<string[]>;
}

export class ClaudeCodeAgent implements AgentProvider {
  readonly name = "claude" as const;
  private readonly claudePath: string;
  private readonly exec: ExecFn;
  private readonly getChangedFiles: (workspace: string) => Promise<string[]>;

  constructor(options: ClaudeCodeAgentOptions = {}) {
    this.claudePath = options.claudePath ?? "claude";
    this.exec = options.exec ?? execFileCapture;
    this.getChangedFiles = options.getChangedFiles ?? changedFiles;
  }

  async run(input: StageInput): Promise<StageResult> {
    const runId = input.runId ?? createRunId();
    const store = new ResultStore(input.workspace);
    const prompt = buildStagePrompt({ ...input, runId });
    await store.writeStageInput(runId, input.stage, prompt);
    const logPath = await store.writeLog(runId, `claude-${input.stage}.log`, "");
    const permissionMode = input.stage === "implement" ? "acceptEdits" : "plan";
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      permissionMode,
      "--debug-file",
      logPath
    ];

    if (input.model) args.push("--model", input.model);
    if (input.effort) args.push("--effort", input.effort);
    args.push(prompt);

    const result = await this.exec(this.claudePath, args, {
      cwd: input.workspace,
      timeoutMs: input.timeoutMs ?? 15 * 60 * 1000
    });

    const outputText = extractClaudeOutput(result.stdout);
    const outputPath = await store.writeStageOutput(runId, input.stage, outputText);
    const files = await this.getChangedFiles(input.workspace);

    if (result.timedOut || result.code !== 0) {
      return {
        ok: false,
        runId,
        stage: input.stage,
        agent: "claude",
        status: "failed",
        outputPath,
        logPath,
        changedFiles: files,
        requiresCodex: false,
        summary: `Claude ${input.stage} failed`,
        error: result.timedOut ? "Claude command timed out" : result.stderr
      };
    }

    return {
      ok: true,
      runId,
      stage: input.stage,
      agent: "claude",
      status: "completed",
      outputPath,
      logPath,
      changedFiles: files,
      requiresCodex: false,
      summary: `Claude ${input.stage} completed`
    };
  }
}

function extractClaudeOutput(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    if (typeof parsed.result === "string") return parsed.result;
  } catch {
    // Fall through to raw output.
  }
  return stdout;
}

function createRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${date}-${suffix}`;
}
