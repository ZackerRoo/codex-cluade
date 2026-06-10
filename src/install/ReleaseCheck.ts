import { readFile } from "node:fs/promises";
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

export interface ReleasePackageJson {
  files?: string[];
  bin?: Record<string, string> | string;
}

export interface ReleaseCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ReleaseCheckResult {
  ok: boolean;
  checks: ReleaseCheck[];
  packedFiles: string[];
}

export interface ValidateReleasePackInput {
  packageJson: ReleasePackageJson;
  packedFiles: string[];
  binContents?: Record<string, string>;
}

export interface RunReleaseCheckOptions {
  cwd?: string;
  timeoutMs?: number;
  exec?: ExecFn;
}

export async function runReleaseCheck(options: RunReleaseCheckOptions = {}): Promise<ReleaseCheckResult> {
  const cwd = options.cwd ?? process.cwd();
  const exec = options.exec ?? execFileCapture;
  const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as ReleasePackageJson;
  const pack = await exec("npm", ["pack", "--dry-run", "--json"], {
    cwd,
    timeoutMs: options.timeoutMs ?? 60_000
  });
  if (pack.timedOut) {
    return { ok: false, packedFiles: [], checks: [{ name: "npm-pack", ok: false, detail: "npm pack timed out" }] };
  }
  if (pack.code !== 0) {
    return { ok: false, packedFiles: [], checks: [{ name: "npm-pack", ok: false, detail: firstLine(pack.stderr || pack.stdout || `exit code ${pack.code}`) }] };
  }
  const packedFiles = parseNpmPackFiles(pack.stdout);
  const binContents: Record<string, string> = {};
  for (const [, path] of binEntries(packageJson)) {
    binContents[path] = await readOptional(join(cwd, path));
  }
  return validateReleasePack({ packageJson, packedFiles, binContents });
}

export function validateReleasePack(input: ValidateReleasePackInput): ReleaseCheckResult {
  const packed = new Set(input.packedFiles);
  const checks: ReleaseCheck[] = [
    fileCheck("package.json", packed),
    fileCheck("README.md", packed),
    directoryCheck("dist/src", packed)
  ];

  for (const [name, path] of binEntries(input.packageJson)) {
    checks.push(fileCheck(`bin:${name}`, packed, path));
    const content = input.binContents?.[path] ?? "";
    checks.push({
      name: `bin-shebang:${name}`,
      ok: content.startsWith("#!/usr/bin/env node"),
      detail: content ? path : `${path} could not be read`
    });
  }

  return {
    ok: checks.every(check => check.ok),
    checks,
    packedFiles: input.packedFiles
  };
}

export function parseNpmPackFiles(output: string): string[] {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) return [];
  const first = parsed[0];
  if (!isRecord(first) || !Array.isArray(first.files)) return [];
  return first.files
    .map(file => isRecord(file) && typeof file.path === "string" ? file.path : undefined)
    .filter((path): path is string => path !== undefined);
}

function fileCheck(name: string, packed: Set<string>, path = name): ReleaseCheck {
  return {
    name,
    ok: packed.has(path),
    detail: path
  };
}

function directoryCheck(path: string, packed: Set<string>): ReleaseCheck {
  return {
    name: path,
    ok: [...packed].some(file => file.startsWith(`${path}/`)),
    detail: path
  };
}

function binEntries(packageJson: ReleasePackageJson): Array<[string, string]> {
  if (typeof packageJson.bin === "string") return [["bin", packageJson.bin]];
  if (!packageJson.bin) return [];
  return Object.entries(packageJson.bin);
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
