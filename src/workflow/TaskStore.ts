import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DelegatedTask, TaskStatus } from "../types.js";

export interface TaskStoreOptions {
  rootDir?: string;
}

export class TaskStore {
  private readonly rootDir: string;

  constructor(options: TaskStoreOptions = {}) {
    this.rootDir = options.rootDir ?? process.env.CODEX_CLAUDE_TASK_STORE ?? join(homedir(), ".codex-claude", "tasks");
  }

  save(task: DelegatedTask): void {
    mkdirSync(this.rootDir, { recursive: true });
    const path = this.pathFor(task.id);
    const tempPath = `${path}.tmp-${process.pid}`;
    writeFileSync(tempPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  }

  get(taskId: string): DelegatedTask | undefined {
    const path = this.pathFor(taskId);
    if (!existsSync(path)) return undefined;
    return parseTask(readFileSync(path, "utf8"));
  }

  list(): DelegatedTask[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir)
      .filter(file => file.endsWith(".json"))
      .map(file => parseTask(readFileSync(join(this.rootDir, file), "utf8")))
      .filter((task): task is DelegatedTask => task !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private pathFor(taskId: string): string {
    return join(this.rootDir, `${safeTaskId(taskId)}.json`);
  }
}

export function isLiveStatus(status: TaskStatus): boolean {
  return status === "pending" || status === "running";
}

function parseTask(content: string): DelegatedTask | undefined {
  try {
    const parsed = JSON.parse(content) as DelegatedTask;
    if (typeof parsed.id !== "string" || typeof parsed.runId !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function safeTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
}
