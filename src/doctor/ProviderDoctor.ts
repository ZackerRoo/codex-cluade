import type { BridgeConfig } from "../config/BridgeConfig.js";
import { execFileCapture, type ExecResult } from "../utils/exec.js";
import type { AgentName } from "../types.js";

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

export type ProviderStatus = "ready" | "missing" | "failed";

export interface ProviderCheck {
  provider: AgentName;
  command: string;
  args: string[];
  status: ProviderStatus;
  version?: string;
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
  { provider: "opencode", pathKey: "opencodePath", envKey: "OPENCODE_CLI_PATH", command: "opencode", args: ["--version"] }
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
      ok: checks.every(check => check.status === "ready"),
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
      return {
        provider: spec.provider,
        command,
        args: spec.args,
        status: "ready",
        version: firstLine(result.stdout || result.stderr)
      };
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
