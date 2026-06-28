import type { BridgeConfig } from "../config/BridgeConfig.js";
import { execFileCapture, type ExecResult } from "../utils/exec.js";
import type { AgentName } from "../types.js";
import { loadShellClaudeEnv, resolveDefaultClaudeModel } from "../config/ClaudeSettings.js";

type ExecFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    input?: string;
    signal?: AbortSignal;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  }
) => Promise<ExecResult>;

export type ProviderStatus = "ready" | "missing" | "failed";

export interface ProviderCheck {
  provider: AgentName;
  command: string;
  args: string[];
  status: ProviderStatus;
  version?: string;
  requestedModel?: string;
  model?: string;
  modelStatus?: ProviderStatus;
  modelError?: string;
  error?: string;
}

export interface ProviderDoctorResult {
  ok: boolean;
  checks: ProviderCheck[];
  languageServers: LanguageServerCheck[];
  languageServerSummary: {
    total: number;
    ready: number;
    missing: number;
    failed: number;
  };
}

export interface LanguageServerCheck {
  language: string;
  command: string;
  args: string[];
  status: ProviderStatus;
  version?: string;
  error?: string;
}

const specs: Array<{ provider: AgentName; pathKey?: keyof BridgeConfig; envKey?: string; command: string; args: string[] }> = [
  { provider: "claude", pathKey: "claudePath", envKey: "CLAUDE_CODE_PATH", command: "claude", args: ["--version"] },
  { provider: "codex-cli", pathKey: "codexPath", envKey: "CODEX_CLI_PATH", command: "codex", args: ["--version"] },
  { provider: "gemini", pathKey: "geminiPath", envKey: "GEMINI_CLI_PATH", command: "gemini", args: ["--version"] },
  { provider: "opencode", pathKey: "opencodePath", envKey: "OPENCODE_CLI_PATH", command: "opencode", args: ["--version"] },
  { provider: "myflicker", pathKey: "myflickerPath", envKey: "MYFLICKER_CLI_PATH", command: "m", args: ["--version"] }
];

const languageServerSpecs: Array<{ language: string; envKey?: string; command: string; args: string[] }> = [
  { language: "python", envKey: "PYRIGHT_LANGSERVER_PATH", command: "pyright-langserver", args: ["--version"] },
  { language: "java", envKey: "JDTLS_PATH", command: "jdtls", args: ["--version"] },
  { language: "go", envKey: "GOPLS_PATH", command: "gopls", args: ["version"] },
  { language: "rust", envKey: "RUST_ANALYZER_PATH", command: "rust-analyzer", args: ["--version"] },
  { language: "c", envKey: "CLANGD_PATH", command: "clangd", args: ["--version"] },
  { language: "cpp", envKey: "CLANGD_PATH", command: "clangd", args: ["--version"] },
  { language: "csharp", envKey: "CSHARP_LS_PATH", command: "csharp-ls", args: ["--version"] },
  { language: "kotlin", envKey: "KOTLIN_LANGUAGE_SERVER_PATH", command: "kotlin-language-server", args: ["--version"] },
  { language: "swift", envKey: "SOURCEKIT_LSP_PATH", command: "sourcekit-lsp", args: ["--version"] },
  { language: "php", envKey: "INTELEPHENSE_PATH", command: "intelephense", args: ["--version"] },
  { language: "ruby", envKey: "SOLARGRAPH_PATH", command: "solargraph", args: ["--version"] }
];

export class ProviderDoctor {
  private readonly exec: ExecFn;

  constructor(private readonly options: {
    config?: BridgeConfig;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    probeModels?: boolean;
    modelProbeTimeoutMs?: number;
    refreshShellEnv?: boolean;
    exec?: ExecFn;
  } = {}) {
    this.exec = options.exec ?? execFileCapture;
  }

  async check(): Promise<ProviderDoctorResult> {
    const [checks, languageServers] = await Promise.all([
      Promise.all(specs.map(spec => this.checkOne(spec))),
      Promise.all(languageServerSpecs.map(spec => this.checkLanguageServer(spec)))
    ]);
    return {
      ok: checks.every(check => check.status === "ready" && (!check.modelStatus || check.modelStatus === "ready")),
      checks,
      languageServers,
      languageServerSummary: summarizeLanguageServers(languageServers)
    };
  }

  private async checkOne(spec: typeof specs[number]): Promise<ProviderCheck> {
    const command = this.resolveCommand(spec);
    try {
      const result = await this.exec(command, spec.args, {
        cwd: this.options.cwd ?? process.cwd(),
        timeoutMs: this.options.timeoutMs ?? 5_000
      });
      if (result.timedOut) {
        return { provider: spec.provider, command, args: spec.args, status: "failed", error: "version check timed out" };
      }
      if (result.code !== 0) {
        return {
          provider: spec.provider,
          command,
          args: spec.args,
          status: "failed",
          error: firstLine(result.stderr || result.stdout || `exit code ${result.code}`)
        };
      }
      const check: ProviderCheck = {
        provider: spec.provider,
        command,
        args: spec.args,
        status: "ready",
        version: firstLine(result.stdout || result.stderr)
      };
      return spec.provider === "claude" && this.options.probeModels
        ? await this.withClaudeModelProbe(check)
        : check;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        provider: spec.provider,
        command,
        args: spec.args,
        status: isMissingError(error) ? "missing" : "failed",
        error: message
      };
    }
  }

  private async withClaudeModelProbe(check: ProviderCheck): Promise<ProviderCheck> {
    try {
      const env = this.options.env ?? process.env;
      const cwd = this.options.cwd ?? process.cwd();
      const requestedModel = resolveDefaultClaudeModel({
        configuredModel: this.options.config?.defaults?.claudeModel,
        env
      });
      const refreshedEnv = (this.options.refreshShellEnv ?? !this.options.exec)
        ? await loadShellClaudeEnv(cwd, env)
        : undefined;
      const result = await this.exec(check.command, [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        requestedModel,
        "Reply exactly: ok"
      ], {
        cwd,
        timeoutMs: this.options.modelProbeTimeoutMs ?? 20_000,
        env: refreshedEnv
      });
      const output = `${result.stdout}\n${result.stderr}`;
      const model = extractClaudeInitModel(output) ?? requestedModel;
      const probeError = firstClaudeError(output);
      if (result.timedOut) {
        return {
          ...check,
          requestedModel,
          model,
          modelStatus: "failed",
          modelError: probeError ? `${probeError}; model probe timed out` : "model probe timed out"
        };
      }
      if (result.code !== 0 || /"is_error"\s*:\s*true/.test(output)) {
        return {
          ...check,
          requestedModel,
          model,
          modelStatus: "failed",
          modelError: probeError || firstLine(result.stderr || result.stdout || `exit code ${result.code}`)
        };
      }
      return { ...check, requestedModel, model, modelStatus: "ready" };
    } catch (error) {
      return {
        ...check,
        modelStatus: isMissingError(error) ? "missing" : "failed",
        modelError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private resolveCommand(spec: typeof specs[number]): string {
    const env = this.options.env ?? process.env;
    const envPath = spec.envKey ? env[spec.envKey] : undefined;
    const configPath = spec.pathKey ? this.options.config?.[spec.pathKey] : undefined;
    return typeof envPath === "string" && envPath.length > 0
      ? envPath
      : typeof configPath === "string" && configPath.length > 0
        ? configPath
        : spec.command;
  }

  private async checkLanguageServer(spec: typeof languageServerSpecs[number]): Promise<LanguageServerCheck> {
    const command = this.resolveLanguageServerCommand(spec);
    try {
      const result = await this.exec(command, spec.args, {
        cwd: this.options.cwd ?? process.cwd(),
        timeoutMs: this.options.timeoutMs ?? 5_000
      });
      if (result.timedOut) {
        return { language: spec.language, command, args: spec.args, status: "failed", error: "version check timed out" };
      }
      if (result.code !== 0) {
        if (isUnsupportedVersionFlag(result.stderr || result.stdout)) {
          return {
            language: spec.language,
            command,
            args: spec.args,
            status: "ready",
            version: "available; version flag unsupported"
          };
        }
        return {
          language: spec.language,
          command,
          args: spec.args,
          status: "failed",
          error: firstLine(result.stderr || result.stdout || `exit code ${result.code}`)
        };
      }
      return {
        language: spec.language,
        command,
        args: spec.args,
        status: "ready",
        version: firstLine(result.stdout || result.stderr)
      };
    } catch (error) {
      return {
        language: spec.language,
        command,
        args: spec.args,
        status: isMissingError(error) ? "missing" : "failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private resolveLanguageServerCommand(spec: typeof languageServerSpecs[number]): string {
    const env = this.options.env ?? process.env;
    const envPath = spec.envKey ? env[spec.envKey] : undefined;
    return typeof envPath === "string" && envPath.length > 0 ? envPath : spec.command;
  }
}

function summarizeLanguageServers(checks: LanguageServerCheck[]): ProviderDoctorResult["languageServerSummary"] {
  return {
    total: checks.length,
    ready: checks.filter(check => check.status === "ready").length,
    missing: checks.filter(check => check.status === "missing").length,
    failed: checks.filter(check => check.status === "failed").length
  };
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0] ?? "";
}

function extractClaudeInitModel(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; subtype?: unknown; model?: unknown };
      if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
        return event.model;
      }
    } catch {
      // Ignore non-JSON lines from hooks or stderr.
    }
  }
  return undefined;
}

function firstClaudeError(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        result?: unknown;
        error?: unknown;
        error_status?: unknown;
        message?: { content?: Array<{ text?: unknown }> };
      };
      if (typeof event.result === "string" && event.result.trim()) return event.result.trim();
      if (typeof event.error === "string" && event.error.trim()) {
        return typeof event.error_status === "number"
          ? `${event.error} (${event.error_status})`
          : event.error.trim();
      }
      const text = event.message?.content?.find(item => typeof item.text === "string")?.text;
      if (typeof text === "string" && text.trim()) return text.trim();
    } catch {
      const trimmed = line.trim();
      if (/model|API Error|Error:/i.test(trimmed)) return trimmed;
    }
  }
  return undefined;
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function isUnsupportedVersionFlag(output: string): boolean {
  return /unknown option|unrecognized option|invalid option|unsupported option/i.test(output)
    && /version/i.test(output);
}
