import { appendFileSync, readFileSync } from "node:fs";
import type { AgentProvider } from "./AgentProvider.js";
import type { AgentName, StageInput, StageResult } from "../types.js";
import { buildStagePrompt } from "../prompts/stagePrompts.js";
import { ResultStore } from "../storage/ResultStore.js";
import { execFileCapture, type ExecResult } from "../utils/exec.js";
import { changedFiles } from "../utils/git.js";

type ExecFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    input?: string;
    signal?: AbortSignal;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  }
) => Promise<ExecResult>;

interface CliAgentOptions {
  exec?: ExecFn;
  getChangedFiles?: (workspace: string) => Promise<string[]>;
}

export interface CodexCliAgentOptions extends CliAgentOptions {
  codexPath?: string;
}

export interface GeminiCliAgentOptions extends CliAgentOptions {
  geminiPath?: string;
}

export interface OpenCodeAgentOptions extends CliAgentOptions {
  opencodePath?: string;
}

export interface MyFlickerAgentOptions extends CliAgentOptions {
  myflickerPath?: string;
}

interface CliSpec {
  name: AgentName;
  commandPath: string;
  logPrefix: string;
  buildArgs(input: StageInput, prompt: string): { args: string[]; input?: string };
  buildResumeCommand?: (commandPath: string, sessionId: string) => string;
}

export class CodexCliAgent implements AgentProvider {
  readonly name = "codex-cli" as const;
  private readonly delegate: CliCodeAgent;

  constructor(options: CodexCliAgentOptions = {}) {
    this.delegate = new CliCodeAgent({
      name: this.name,
      commandPath: options.codexPath ?? "codex",
      logPrefix: "codex-cli",
      exec: options.exec,
      getChangedFiles: options.getChangedFiles,
      buildArgs: input => {
        const args = [
          "exec",
          "--json",
          "--cd",
          input.workspace,
          "--skip-git-repo-check",
          "--sandbox",
          input.stage === "implement" ? "danger-full-access" : "read-only"
        ];
        if (input.stage === "implement") args.push("--dangerously-bypass-approvals-and-sandbox");
        if (input.model) args.push("--model", input.model);
        if (input.effort) args.push("--config", `model_reasoning_effort="${input.effort}"`);
        args.push("-");
        return { args };
      }
    });
  }

  run(input: StageInput): Promise<StageResult> {
    return this.delegate.run(input);
  }
}

export class GeminiCliAgent implements AgentProvider {
  readonly name = "gemini" as const;
  private readonly delegate: CliCodeAgent;

  constructor(options: GeminiCliAgentOptions = {}) {
    this.delegate = new CliCodeAgent({
      name: this.name,
      commandPath: options.geminiPath ?? "gemini",
      logPrefix: "gemini",
      exec: options.exec,
      getChangedFiles: options.getChangedFiles,
      buildArgs: (input, prompt) => {
        const args = [
          "--prompt",
          prompt,
          "--output-format",
          "stream-json",
          "--approval-mode",
          input.stage === "implement" ? "yolo" : "plan"
        ];
        if (input.model) args.push("--model", input.model);
        return { args, input: "" };
      }
    });
  }

  run(input: StageInput): Promise<StageResult> {
    return this.delegate.run(input);
  }
}

export class OpenCodeAgent implements AgentProvider {
  readonly name = "opencode" as const;
  private readonly delegate: CliCodeAgent;

  constructor(options: OpenCodeAgentOptions = {}) {
    this.delegate = new CliCodeAgent({
      name: this.name,
      commandPath: options.opencodePath ?? "opencode",
      logPrefix: "opencode",
      exec: options.exec,
      getChangedFiles: options.getChangedFiles,
      buildArgs: (input, prompt) => {
        const args = [
          "run",
          "--format",
          "json",
          "--dir",
          input.workspace
        ];
        if (input.stage === "implement") args.push("--dangerously-skip-permissions");
        if (input.model) args.push("--model", input.model);
        args.push(prompt);
        return { args, input: "" };
      }
    });
  }

  run(input: StageInput): Promise<StageResult> {
    return this.delegate.run(input);
  }
}

export class MyFlickerAgent implements AgentProvider {
  readonly name = "myflicker" as const;
  private readonly delegate: CliCodeAgent;

  constructor(options: MyFlickerAgentOptions = {}) {
    this.delegate = new CliCodeAgent({
      name: this.name,
      commandPath: options.myflickerPath ?? "m",
      logPrefix: "myflicker",
      exec: options.exec,
      getChangedFiles: options.getChangedFiles,
      buildArgs: (input, prompt) => {
        const args = [
          "-q",
          "--cwd",
          input.workspace,
          "--output-format",
          "stream-json"
        ];
        if (input.stage === "implement") {
          args.push("--approval-mode", "yolo");
        } else {
          args.push("--tools", JSON.stringify(readOnlyMyFlickerTools()));
        }
        if (input.agentSessionId) args.push("--resume", input.agentSessionId);
        if (input.model) args.push("--model", input.model);
        if (input.effort) args.push("--thinking-level", input.effort);
        args.push(prompt);
        return { args, input: "" };
      },
      buildResumeCommand: (commandPath, sessionId) => `${shellQuote(commandPath)} --resume ${shellQuote(sessionId)}`
    });
  }

  run(input: StageInput): Promise<StageResult> {
    return this.delegate.run(input);
  }
}

class CliCodeAgent implements AgentProvider {
  readonly name: AgentName;
  private readonly commandPath: string;
  private readonly logPrefix: string;
  private readonly exec: ExecFn;
  private readonly getChangedFiles: (workspace: string) => Promise<string[]>;
  private readonly buildArgs: CliSpec["buildArgs"];
  private readonly buildResumeCommand?: CliSpec["buildResumeCommand"];

  constructor(options: CliSpec & CliAgentOptions) {
    this.name = options.name;
    this.commandPath = options.commandPath;
    this.logPrefix = options.logPrefix;
    this.exec = options.exec ?? execFileCapture;
    this.getChangedFiles = options.getChangedFiles ?? changedFiles;
    this.buildArgs = options.buildArgs;
    this.buildResumeCommand = options.buildResumeCommand;
  }

  async run(input: StageInput): Promise<StageResult> {
    const runId = input.runId ?? createRunId();
    const store = new ResultStore(input.workspace);
    const prompt = buildStagePrompt({ ...input, runId });
    await store.writeStageInput(runId, input.stage, prompt);
    const stdoutPath = await store.writeLog(runId, `${this.logPrefix}-${input.stage}.stdout.log`, "");
    const stderrPath = await store.writeLog(runId, `${this.logPrefix}-${input.stage}.stderr.log`, "");
    const { args, input: explicitInput } = this.buildArgs(input, prompt);
    const result = await this.exec(this.commandPath, args, {
      cwd: input.workspace,
      timeoutMs: input.timeoutMs ?? 15 * 60 * 1000,
      input: explicitInput ?? prompt,
      signal: input.signal,
      onStdoutChunk: chunk => appendFileSync(stdoutPath, chunk, "utf8"),
      onStderrChunk: chunk => appendFileSync(stderrPath, chunk, "utf8")
    });
    if (result.stdout) appendMissingContent(stdoutPath, result.stdout);
    if (result.stderr) appendMissingContent(stderrPath, result.stderr);

    const outputText = extractCliOutput(result.stdout);
    const agentSessionId = extractCliSessionId(result.stdout) ?? input.agentSessionId;
    const resumeCommand = agentSessionId && this.buildResumeCommand
      ? this.buildResumeCommand(this.commandPath, agentSessionId)
      : undefined;
    const outputPath = await store.writeStageOutput(runId, input.stage, outputText);
    const files = await this.getChangedFiles(input.workspace);

    if (result.timedOut || result.code !== 0) {
      return {
        ok: false,
        runId,
        stage: input.stage,
        agent: this.name,
        status: "failed",
        outputPath,
        logPath: stderrPath,
        agentSessionId,
        resumeCommand,
        changedFiles: files,
        requiresCodex: false,
        summary: `${this.name} ${input.stage} failed`,
        error: result.timedOut ? `${this.name} command timed out` : result.stderr || result.stdout || `${this.name} exited with code ${result.code}`
      };
    }

    return {
      ok: true,
      runId,
      stage: input.stage,
      agent: this.name,
      status: "completed",
      outputPath,
      logPath: stdoutPath,
      agentSessionId,
      resumeCommand,
      changedFiles: files,
      requiresCodex: false,
      summary: `${this.name} ${input.stage} completed`
    };
  }
}

function extractCliOutput(stdout: string): string {
  const streamResult = extractStreamResult(stdout);
  if (streamResult) return streamResult;
  return stdout;
}

function extractStreamResult(stdout: string): string | undefined {
  const chunks: string[] = [];
  for (const line of stdout.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.result === "string") return parsed.result;
      if (typeof parsed.text === "string") chunks.push(parsed.text);
      if (typeof parsed.delta === "string") chunks.push(parsed.delta);
    } catch {
      // Ignore non-JSON stream lines.
    }
  }
  return chunks.length > 0 ? chunks.join("") : undefined;
}

function extractCliSessionId(stdout: string): string | undefined {
  for (const line of stdout.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const direct = firstString(
        parsed.sessionId,
        parsed.session_id,
        parsed.sessionID,
        parsed.conversationId,
        parsed.conversation_id
      );
      if (direct) return direct;
      const message = parsed.message;
      if (isRecord(message)) {
        const nested = firstString(message.sessionId, message.session_id, message.conversationId, message.conversation_id);
        if (nested) return nested;
      }
    } catch {
      // Ignore non-JSON stream lines.
    }
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readOnlyMyFlickerTools(): Record<string, boolean> {
  return {
    write: false,
    edit: false,
    bash: false,
    docs_write: false,
    docs_edit: false,
    todoWrite: false
  };
}

function appendMissingContent(path: string, content: string): void {
  try {
    const existing = readFileSync(path, "utf8");
    if (!existing.includes(content)) appendFileSync(path, content, "utf8");
  } catch {
    appendFileSync(path, content, "utf8");
  }
}

function createRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${date}-${suffix}`;
}
