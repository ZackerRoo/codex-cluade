import { execFileCapture } from "./exec.js";

export async function isGitRepository(workspace: string): Promise<boolean> {
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

  return result.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.slice(3).trim())
    .filter(Boolean);
}
