import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileCapture, type ExecResult } from "../utils/exec.js";

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

export interface InstallSmokeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface InstallSmokeResult {
  ok: boolean;
  tempDir: string;
  tarball?: string;
  checks: InstallSmokeCheck[];
}

export interface RunInstallSmokeOptions {
  cwd?: string;
  tempRoot?: string;
  timeoutMs?: number;
  exec?: ExecFn;
  mkdtemp?: (prefix: string) => Promise<string>;
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
}

export async function runInstallSmoke(options: RunInstallSmokeOptions = {}): Promise<InstallSmokeResult> {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const exec = options.exec ?? execFileCapture;
  const makeTempDir = options.mkdtemp ?? mkdtemp;
  const makeDir = options.mkdir ?? mkdir;
  const write = options.writeFile ?? writeFile;
  const root = options.tempRoot ?? tmpdir();
  await makeDir(root, { recursive: true });
  const tempDir = await makeTempDir(join(root, "codex-claude-install-smoke-"));
  const installDir = join(tempDir, "install");
  await makeDir(installDir, { recursive: true });
  await write(join(installDir, "package.json"), "{\"private\":true}\n", "utf8");

  const checks: InstallSmokeCheck[] = [];
  const pack = await exec("npm", ["pack", "--pack-destination", tempDir, "--json"], { cwd, timeoutMs });
  const packCheck = commandCheck("npm-pack", pack);
  checks.push(packCheck);
  if (!packCheck.ok) return finish(tempDir, checks);

  const tarballName = parsePackTarballName(pack.stdout);
  if (!tarballName) {
    checks.push({ name: "npm-pack-tarball", ok: false, detail: "npm pack output did not include a tarball filename" });
    return finish(tempDir, checks);
  }
  const tarball = join(tempDir, tarballName);

  const install = await exec("npm", ["install", tarball, "--ignore-scripts"], { cwd: installDir, timeoutMs });
  const installCheck = commandCheck("npm-install", install);
  checks.push(installCheck);
  if (!installCheck.ok) return finish(tempDir, checks, tarball);

  const binDir = join(installDir, "node_modules", ".bin");
  const packageRoot = join(installDir, "node_modules", "codex-claude-agent-bridge");
  const bridge = join(binDir, "claude-agent-bridge");
  const dashboard = join(binDir, "claude-agent-bridge-dashboard");
  const mcpDashboard = join(binDir, "claude-agent-bridge-mcp-dashboard");
  const configPath = join(tempDir, "codex-config.toml");
  const serverPath = join(packageRoot, "dist", "src", "mcpDashboardServer.js");

  checks.push(commandCheck("bin:setup-codex", await exec(bridge, [
    "setup-codex",
    "--config",
    configPath,
    "--server-path",
    serverPath
  ], { cwd: installDir, timeoutMs })));

  checks.push(commandCheck("bin:doctor", await exec(bridge, [
    "doctor",
    "--config",
    configPath,
    "--timeout-ms",
    "1000"
  ], { cwd: installDir, timeoutMs })));

  checks.push(expectedFailureCheck("bin:dashboard-entrypoint", await exec(dashboard, ["--port", "0"], { cwd: installDir, timeoutMs })));
  checks.push(expectedFailureCheck("bin:mcp-dashboard-entrypoint", await exec(mcpDashboard, ["--port", "0"], { cwd: installDir, timeoutMs })));

  return finish(tempDir, checks, tarball);
}

export function parsePackTarballName(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const first = parsed[0];
    return isRecord(first) && typeof first.filename === "string" ? first.filename : undefined;
  } catch {
    return undefined;
  }
}

function commandCheck(name: string, result: ExecResult): InstallSmokeCheck {
  return {
    name,
    ok: !result.timedOut && result.code === 0,
    detail: result.timedOut ? "timed out" : firstLine(result.stderr || result.stdout || `exit code ${result.code}`)
  };
}

function expectedFailureCheck(name: string, result: ExecResult): InstallSmokeCheck {
  return {
    name,
    ok: !result.timedOut && result.code !== 0,
    detail: result.timedOut ? "timed out" : firstLine(result.stderr || result.stdout || `exit code ${result.code}`)
  };
}

function finish(tempDir: string, checks: InstallSmokeCheck[], tarball?: string): InstallSmokeResult {
  return {
    ok: checks.every(check => check.ok),
    tempDir,
    tarball,
    checks
  };
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
