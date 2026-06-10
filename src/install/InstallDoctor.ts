import { readFile } from "node:fs/promises";
import { defaultCodexConfigPath } from "../config/CodexSetup.js";
import type { BridgeConfig } from "../config/BridgeConfig.js";
import { ProviderDoctor, type ProviderDoctorResult } from "../doctor/ProviderDoctor.js";
import type { ExecResult } from "../utils/exec.js";

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

export interface InstallDoctorOptions {
  codexConfigPath?: string;
  bridgeConfig?: BridgeConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  exec?: ExecFn;
}

export interface InstallDoctorResult {
  ok: boolean;
  codexConfig: {
    path: string;
    exists: boolean;
    bridgeConfigured: boolean;
    dashboardConfigured: boolean;
    dashboardPort?: number;
    serverPath?: string;
    error?: string;
  };
  providers: ProviderDoctorResult;
  nextSteps: string[];
}

export async function runInstallDoctor(options: InstallDoctorOptions = {}): Promise<InstallDoctorResult> {
  const [codexConfig, providers] = await Promise.all([
    inspectCodexConfig(options.codexConfigPath ?? defaultCodexConfigPath(options.env)),
    new ProviderDoctor({
      config: options.bridgeConfig,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      exec: options.exec
    }).check()
  ]);
  const nextSteps = buildNextSteps(codexConfig, providers);
  return {
    ok: codexConfig.bridgeConfigured && providers.ok,
    codexConfig,
    providers,
    nextSteps
  };
}

async function inspectCodexConfig(path: string): Promise<InstallDoctorResult["codexConfig"]> {
  try {
    const content = await readFile(path, "utf8");
    const bridgeConfigured = /^\s*\[mcp_servers\.claude-agent-bridge]\s*$/m.test(content);
    const serverPath = bridgeConfigured ? parseServerPath(content) : undefined;
    const dashboardPort = bridgeConfigured ? parseDashboardPort(content) : undefined;
    const dashboardConfigured = Boolean(serverPath?.endsWith("mcpDashboardServer.js"));
    return {
      path,
      exists: true,
      bridgeConfigured,
      dashboardConfigured,
      dashboardPort,
      serverPath
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { path, exists: false, bridgeConfigured: false, dashboardConfigured: false };
    return {
      path,
      exists: false,
      bridgeConfigured: false,
      dashboardConfigured: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseDashboardPort(content: string): number | undefined {
  const args = parseArgsArray(content);
  const index = args.indexOf("--port");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function parseServerPath(content: string): string | undefined {
  const args = parseArgsArray(content);
  return args.find(arg => /mcpDashboardServer\.js$|mcpServer\.js$/.test(arg));
}

function parseArgsArray(content: string): string[] {
  const match = content.match(/^\s*args\s*=\s*\[([^\]]*)]/m);
  if (!match) return [];
  const values: string[] = [];
  const pattern = /"((?:\\.|[^"])*)"/g;
  let value: RegExpExecArray | null;
  while ((value = pattern.exec(match[1])) !== null) {
    values.push(value[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\"));
  }
  return values;
}

function buildNextSteps(codexConfig: InstallDoctorResult["codexConfig"], providers: ProviderDoctorResult): string[] {
  const steps: string[] = [];
  if (!codexConfig.exists) {
    steps.push(`Run claude-agent-bridge setup-codex --write to create ${codexConfig.path}.`);
  } else if (!codexConfig.bridgeConfigured) {
    steps.push(`Run claude-agent-bridge setup-codex --write to add the claude-agent-bridge MCP block to ${codexConfig.path}.`);
  } else if (!codexConfig.dashboardConfigured) {
    steps.push(`Optional: run claude-agent-bridge setup-codex --write to use the unified MCP + Dashboard runtime.`);
  }
  const missingProviders = providers.checks.filter(check => check.status !== "ready").map(check => check.provider);
  if (missingProviders.length > 0) {
    steps.push(`Install or configure provider CLI paths for: ${missingProviders.join(", ")}.`);
  }
  if (providers.languageServerSummary.ready < providers.languageServerSummary.total) {
    steps.push(`Optional: install missing language servers for richer code_definition, code_references, and code_diagnostics support.`);
  }
  return steps;
}
