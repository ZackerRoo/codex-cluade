import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { TaskGitDiffFile } from "../types.js";

export type WorkspaceSnapshot = Map<string, { size: number; mtimeMs: number }>;

const EXCLUDED_DIRS = new Set([
  ".agent-runs",
  ".codex-claude",
  ".git",
  "build",
  "dist",
  "node_modules",
  "target",
  ".next",
  ".turbo"
]);

export async function createWorkspaceSnapshot(workspace: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  await collectFiles(workspace, workspace, snapshot);
  return snapshot;
}

export function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): TaskGitDiffFile[] {
  const files: TaskGitDiffFile[] = [];
  for (const [path, current] of after) {
    const previous = before.get(path);
    if (!previous) {
      files.push({ path, status: "added" });
      continue;
    }
    if (previous.size !== current.size || previous.mtimeMs !== current.mtimeMs) {
      files.push({ path, status: "modified" });
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) files.push({ path, status: "deleted" });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function collectFiles(root: string, dir: string, snapshot: WorkspaceSnapshot): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, absolute, snapshot);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(absolute);
    snapshot.set(relative(root, absolute).replaceAll("\\", "/"), {
      size: info.size,
      mtimeMs: info.mtimeMs
    });
  }
}
