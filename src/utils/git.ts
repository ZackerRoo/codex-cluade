import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { execFileCapture } from "./exec.js";
import type { TaskGitCheckpoint, TaskGitDiff, TaskGitDiffFile } from "../types.js";

const INTERNAL_GIT_PATH_PREFIXES = [".codex-claude/memory/"];

export async function isGitRepository(workspace: string): Promise<boolean> {
  if (!findGitMarker(workspace)) return false;
  const result = await execFileCapture("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: workspace,
    timeoutMs: 5000
  });
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function changedFiles(workspace: string): Promise<string[]> {
  if (!(await isGitRepository(workspace))) return [];

  const result = await execFileCapture("git", ["status", "--short"], {
    cwd: workspace,
    timeoutMs: 5000
  });

  if (result.code !== 0) return [];

  return parseChangedFiles(result.stdout);
}

export async function createGitCheckpoint(workspace: string): Promise<TaskGitCheckpoint> {
  const createdAt = new Date().toISOString();
  try {
    if (!(await isGitRepository(workspace))) {
      return { supported: false, clean: false, createdAt, error: "Workspace is not a git repository." };
    }
    const head = await gitStdout(workspace, ["rev-parse", "HEAD"]);
    const status = parseStatusLines(await gitStdout(workspace, ["status", "--short"]))
      .filter(line => !isInternalGeneratedPath(parseGitDiffFiles(line)[0]?.path ?? ""));
    return {
      supported: true,
      clean: status.length === 0,
      head: head.trim(),
      status,
      createdAt
    };
  } catch (error) {
    return {
      supported: false,
      clean: false,
      createdAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function createGitDiff(workspace: string): Promise<TaskGitDiff> {
  const generatedAt = new Date().toISOString();
  try {
    if (!(await isGitRepository(workspace))) {
      return { supported: false, files: [], generatedAt, error: "Workspace is not a git repository." };
    }
    const status = await gitStdout(workspace, ["status", "--short"]);
    const files = parseGitDiffFiles(status).filter(file => !isInternalGeneratedPath(file.path));
    const trackedPaths = files.filter(file => file.status !== "untracked").map(file => file.path);
    const patchResult = trackedPaths.length > 0
      ? await execFileCapture("git", ["diff", "--binary", "HEAD", "--", ...trackedPaths], {
        cwd: workspace,
        timeoutMs: 10_000
      })
      : { code: 0, stdout: "", stderr: "", timedOut: false };
    return {
      supported: true,
      files,
      patch: patchResult.code === 0 ? patchResult.stdout : "",
      generatedAt,
      error: patchResult.code === 0 ? undefined : patchResult.stderr.trim() || "git diff failed"
    };
  } catch (error) {
    return {
      supported: false,
      files: [],
      generatedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function rollbackGitTaskChanges(workspace: string, expectedDiff?: TaskGitDiff): Promise<{ ok: boolean; diff?: TaskGitDiff; error?: string }> {
  if (!(await isGitRepository(workspace))) return { ok: false, error: "Workspace is not a git repository." };
  const currentDiff = await createGitDiff(workspace);
  if (!currentDiff.supported) return { ok: false, diff: currentDiff, error: currentDiff.error ?? "Git diff is not available." };
  if (!diffMatches(expectedDiff, currentDiff)) {
    return { ok: false, diff: currentDiff, error: "Workspace changed after this task; refusing automatic rollback." };
  }

  const trackedPaths = currentDiff.files.filter(file => file.status !== "untracked").map(file => file.path);
  const untrackedPaths = currentDiff.files.filter(file => file.status === "untracked").map(file => file.path);
  if (trackedPaths.length > 0) {
    const restore = await execFileCapture("git", ["restore", "--worktree", "--staged", "--", ...trackedPaths], {
      cwd: workspace,
      timeoutMs: 10_000
    });
    if (restore.code !== 0) return { ok: false, diff: currentDiff, error: restore.stderr.trim() || "git restore failed" };
  }
  for (const path of untrackedPaths) {
    await rm(safeWorkspacePath(workspace, path), { recursive: true, force: true });
  }
  return { ok: true, diff: currentDiff };
}

export function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => line.slice(3).trim())
    .filter(Boolean);
}

export function parseGitDiffFiles(statusOutput: string): TaskGitDiffFile[] {
  return statusOutput
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => {
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      return { path: normalizeStatusPath(path), status: statusFromCode(code) };
    })
    .filter(file => Boolean(file.path));
}

function parseStatusLines(statusOutput: string): string[] {
  return statusOutput.split("\n").map(line => line.trimEnd()).filter(Boolean);
}

async function gitStdout(workspace: string, args: string[]): Promise<string> {
  const result = await execFileCapture("git", args, { cwd: workspace, timeoutMs: 5000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function statusFromCode(code: string): TaskGitDiffFile["status"] {
  if (code === "??") return "untracked";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("M")) return "modified";
  return "unknown";
}

function normalizeStatusPath(path: string): string {
  const renameSeparator = " -> ";
  return path.includes(renameSeparator) ? path.split(renameSeparator).at(-1)?.trim() ?? path : path;
}

function diffMatches(expected: TaskGitDiff | undefined, current: TaskGitDiff): boolean {
  if (!expected) return true;
  const expectedFiles = expected.files.filter(file => !isInternalGeneratedPath(file.path)).map(file => `${file.status}:${file.path}`).sort();
  const currentFiles = current.files.filter(file => !isInternalGeneratedPath(file.path)).map(file => `${file.status}:${file.path}`).sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(currentFiles)) return false;
  return (expected.patch ?? "") === (current.patch ?? "");
}

function isInternalGeneratedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return INTERNAL_GIT_PATH_PREFIXES.some(prefix => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function safeWorkspacePath(workspace: string, path: string): string {
  const workspaceRoot = resolve(workspace);
  const target = resolve(workspaceRoot, path);
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error(`Refusing to remove path outside workspace: ${path}`);
  }
  return target;
}

function findGitMarker(workspace: string): string | undefined {
  let current = resolve(workspace);
  for (let depth = 0; depth < 20; depth += 1) {
    const marker = join(current, ".git");
    if (existsSync(marker)) return marker;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}
