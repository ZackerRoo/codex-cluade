import type { AgentProvider } from "./AgentProvider.js";
import type { StageInput, StageResult } from "../types.js";
import { buildStagePrompt } from "../prompts/stagePrompts.js";
import { ResultStore } from "../storage/ResultStore.js";
import { execFileCapture, type ExecResult } from "../utils/exec.js";
import { changedFiles } from "../utils/git.js";
import { resolveClaudeSessionInfo } from "./ClaudeSessionResolver.js";

type ExecFn = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; input?: string; signal?: AbortSignal }
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
    const defaultDisallowedTools = input.stage === "implement" ? [] : ["Edit", "MultiEdit", "Write", "NotebookEdit"];
    const permissionMode = input.permission?.mode ?? (input.stage === "implement" ? "bypassPermissions" : "default");
    const allowedTools = input.permission?.allowedTools ?? [];
    const disallowedTools = input.permission?.disallowedTools ?? defaultDisallowedTools;
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      permissionMode,
      "--debug-file",
      logPath
    ];
    if (input.agentSessionId) {
      args.push("--resume", input.agentSessionId);
    }
    if (allowedTools.length > 0) {
      args.push("--allowedTools", allowedTools.join(","));
    }
    if (disallowedTools.length > 0) {
      args.push("--disallowedTools", disallowedTools.join(","));
    }

    if (input.model) args.push("--model", input.model);
    if (input.effort) args.push("--effort", input.effort);

    const startedAt = new Date();
    const result = await this.exec(this.claudePath, args, {
      cwd: input.workspace,
      timeoutMs: input.timeoutMs ?? 15 * 60 * 1000,
      input: prompt,
      signal: input.signal
    });

    const outputText = extractClaudeOutput(result.stdout);
    const outputPath = await store.writeStageOutput(runId, input.stage, outputText);
    const files = await this.getChangedFiles(input.workspace);
    const session = await resolveClaudeSessionInfo({
      workspace: input.workspace,
      stdout: result.stdout,
      startedAt,
      claudePath: this.claudePath
    });

    if (result.timedOut || result.code !== 0) {
      let error: string;
      if (result.timedOut) {
        error = "Claude command timed out";
      } else if (result.stderr) {
        error = result.stderr;
      } else {
        const detail = result.stdout
          ? `empty stderr (exit code ${result.code})`
          : `empty stdout and stderr (exit code ${result.code})`;
        error = `Claude CLI produced no output: ${detail}. See log at ${logPath}`;
      }
      return {
        ok: false,
        runId,
        stage: input.stage,
        agent: "claude",
        status: "failed",
        outputPath,
        logPath,
        agentSessionId: session?.sessionId,
        agentTranscriptPath: session?.transcriptPath,
        resumeCommand: session?.resumeCommand,
        changedFiles: files,
        requiresCodex: false,
        summary: `Claude ${input.stage} failed`,
        error
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
      agentSessionId: session?.sessionId,
      agentTranscriptPath: session?.transcriptPath,
      resumeCommand: session?.resumeCommand,
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
