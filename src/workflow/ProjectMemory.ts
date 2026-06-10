import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentName, DelegatedTask, ProjectMemory, ProjectMemoryEntry } from "../types.js";
import { execFileCapture } from "../utils/exec.js";

export interface ProjectMemoryStoreOptions {
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 60;

export class ProjectMemoryStore {
  readonly rootDir: string;
  readonly jsonPath: string;
  readonly markdownPath: string;
  private readonly maxEntries: number;

  constructor(readonly workspace: string, options: ProjectMemoryStoreOptions = {}) {
    const root = resolve(workspace);
    this.rootDir = join(root, ".codex-claude", "memory");
    this.jsonPath = join(this.rootDir, "project-memory.json");
    this.markdownPath = join(this.rootDir, "project-memory.md");
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async read(): Promise<ProjectMemory> {
    try {
      const content = await readFile(this.jsonPath, "utf8");
      const parsed = JSON.parse(content) as Partial<ProjectMemory>;
      return {
        workspace: parsed.workspace ?? resolve(this.workspace),
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
        entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isMemoryEntry) : []
      };
    } catch {
      return {
        workspace: resolve(this.workspace),
        updatedAt: new Date(0).toISOString(),
        entries: []
      };
    }
  }

  async recordTask(task: DelegatedTask): Promise<ProjectMemory> {
    const memory = await this.read();
    const entry = taskMemoryEntry(task);
    const entries = [entry, ...memory.entries.filter(item => item.taskId !== task.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, this.maxEntries);
    const updated: ProjectMemory = {
      workspace: resolve(task.workspace),
      updatedAt: new Date().toISOString(),
      entries
    };
    await this.ensureMemoryIsGitIgnored();
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.jsonPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await writeFile(this.markdownPath, renderProjectMemoryMarkdown(updated), "utf8");
    return updated;
  }

  private async ensureMemoryIsGitIgnored(): Promise<void> {
    if (!findGitMarker(this.workspace)) return;
    const result = await execFileCapture("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: this.workspace,
      timeoutMs: 5000
    });
    if (result.code !== 0) return;

    const excludePath = resolve(this.workspace, result.stdout.trim());
    const pattern = ".codex-claude/memory/";
    try {
      const existing = await readFile(excludePath, "utf8");
      if (existing.split("\n").some(line => line.trim() === pattern)) return;
      await writeFile(excludePath, `${existing.replace(/\s*$/, "\n")}${pattern}\n`, "utf8");
    } catch {
      await mkdir(dirname(excludePath), { recursive: true });
      await writeFile(excludePath, `${pattern}\n`, "utf8");
    }
  }
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

export function taskMemoryEntry(task: DelegatedTask): ProjectMemoryEntry {
  return {
    taskId: task.id,
    runId: task.runId,
    status: task.status,
    request: compact(task.request),
    summary: compact(task.resultSummary?.summary ?? task.error ?? ""),
    changedFiles: unique([
      ...(task.resultSummary?.changedFiles ?? []),
      ...(task.gitDiff?.files ?? []).map(file => file.path)
    ]),
    providerAttempts: providerAttempts(task),
    verificationStatus: task.verification?.status ?? task.resultSummary?.verification?.status,
    repairTaskId: task.verification?.repairTaskId ?? task.resultSummary?.verification?.repairedBy,
    updatedAt: task.updatedAt
  };
}

export function renderProjectMemoryMarkdown(memory: ProjectMemory): string {
  const lines: Array<string | undefined> = [
    "# Project memory",
    "",
    `Workspace: ${memory.workspace}`,
    `Updated: ${memory.updatedAt}`,
    "",
    "## Recent task learnings",
    ""
  ];
  if (memory.entries.length === 0) {
    lines.push("- none recorded yet", "");
    return lines.join("\n");
  }
  for (const entry of memory.entries) {
    lines.push(
      `- ${entry.updatedAt} ${entry.taskId}: ${entry.status}`,
      `  Request: ${entry.request || "-"}`,
      `  Summary: ${entry.summary || "-"}`,
      entry.providerAttempts.length > 0 ? `  Providers: ${entry.providerAttempts.join(" -> ")}` : undefined,
      entry.changedFiles.length > 0 ? `  Changed files: ${entry.changedFiles.join(", ")}` : undefined,
      entry.verificationStatus ? `  Verification: ${entry.verificationStatus}` : undefined,
      entry.repairTaskId ? `  Repair task: ${entry.repairTaskId}` : undefined,
      ""
    );
  }
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function providerAttempts(task: DelegatedTask): AgentName[] {
  const attempts = task.resultSummary?.providerAttempts ?? [];
  if (attempts.length > 0) return attempts;
  return task.preferredAgent ? [task.preferredAgent] : [];
}

function isMemoryEntry(value: unknown): value is ProjectMemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProjectMemoryEntry>;
  return typeof candidate.taskId === "string"
    && typeof candidate.runId === "string"
    && typeof candidate.status === "string"
    && typeof candidate.request === "string"
    && typeof candidate.updatedAt === "string";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compact(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
