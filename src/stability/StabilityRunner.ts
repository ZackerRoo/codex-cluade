import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentName, DelegatedTask, TaskStatus } from "../types.js";
import type { TaskManager } from "../workflow/TaskManager.js";

export type StabilityRunStatus = "running" | "completed" | "cancelled";

export interface StabilityRunInput {
  request: string;
  workspaceRoot: string;
  providers: AgentName[];
  iterations: number;
  verifyCommand?: string;
  maxRepairAttempts?: number;
  timeoutMs?: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface StabilityTaskRecord {
  taskId: string;
  provider: AgentName;
  iteration: number;
  workspace: string;
  status: TaskStatus;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
}

export interface StabilityProviderSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  successRate: number;
  averageDurationMs?: number;
  failureSamples: string[];
}

export interface StabilityRunSummary extends StabilityProviderSummary {
  byProvider: Record<string, StabilityProviderSummary>;
}

export interface StabilityRun {
  id: string;
  status: StabilityRunStatus;
  request: string;
  workspaceRoot: string;
  providers: AgentName[];
  iterations: number;
  verifyCommand?: string;
  maxRepairAttempts?: number;
  timeoutMs?: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  tasks: StabilityTaskRecord[];
  summary: StabilityRunSummary;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface StabilityRunStoreOptions {
  rootDir?: string;
}

export class StabilityRunStore {
  private readonly rootDir: string;

  constructor(options: StabilityRunStoreOptions = {}) {
    this.rootDir = options.rootDir ?? process.env.CODEX_CLAUDE_STABILITY_STORE ?? join(homedir(), ".codex-claude", "stability");
  }

  save(run: StabilityRun): void {
    mkdirSync(this.rootDir, { recursive: true });
    const path = this.pathFor(run.id);
    const tempPath = `${path}.tmp-${process.pid}`;
    writeFileSync(tempPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  }

  get(runId: string): StabilityRun | undefined {
    const path = this.pathFor(runId);
    if (!existsSync(path)) return undefined;
    return parseRun(readFileSync(path, "utf8"));
  }

  list(): StabilityRun[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir)
      .filter(file => file.endsWith(".json"))
      .map(file => parseRun(readFileSync(join(this.rootDir, file), "utf8")))
      .filter((run): run is StabilityRun => run !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private pathFor(runId: string): string {
    return join(this.rootDir, `${runId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  }
}

export class StabilityRunner {
  constructor(
    private readonly options: {
      taskManager: TaskManager;
      store?: StabilityRunStore;
    }
  ) {}

  async start(input: StabilityRunInput): Promise<StabilityRun> {
    validateInput(input);
    const now = new Date().toISOString();
    const id = createStabilityRunId();
    const tasks: StabilityTaskRecord[] = [];
    const store = this.store;

    for (const provider of input.providers) {
      for (let iteration = 1; iteration <= input.iterations; iteration += 1) {
        const taskId = `${id}-${provider}-${iteration}`;
        const workspace = join(input.workspaceRoot, id, `${provider}-${iteration}`);
        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, "README.md"), stabilityWorkspaceReadme(id, provider, iteration), "utf8");
        const launched = await this.options.taskManager.run({
          mode: "background",
          workspace,
          request: buildStabilityRequest(input.request, id, provider, iteration),
          stages: ["implement"],
          routing: {},
          preferredAgent: provider,
          runId: taskId,
          verifyCommand: input.verifyCommand,
          maxRepairAttempts: input.maxRepairAttempts ?? 0,
          timeoutMs: input.timeoutMs,
          model: input.model,
          effort: input.effort
        });
        tasks.push({
          taskId: launched.taskId ?? taskId,
          provider,
          iteration,
          workspace,
          status: launched.task?.status ?? "pending",
          createdAt: launched.task?.createdAt,
          updatedAt: launched.task?.updatedAt
        });
      }
    }

    const run: StabilityRun = {
      id,
      status: "running",
      request: input.request,
      workspaceRoot: input.workspaceRoot,
      providers: input.providers,
      iterations: input.iterations,
      verifyCommand: input.verifyCommand,
      maxRepairAttempts: input.maxRepairAttempts ?? 0,
      timeoutMs: input.timeoutMs,
      model: input.model,
      effort: input.effort,
      tasks,
      summary: summarize(tasks),
      createdAt: now,
      updatedAt: now
    };
    store.save(run);
    return run;
  }

  async refresh(runId: string): Promise<StabilityRun | undefined> {
    const run = this.store.get(runId);
    if (!run) return undefined;
    return this.refreshRun(run);
  }

  async list(): Promise<StabilityRun[]> {
    const runs: StabilityRun[] = [];
    for (const run of this.store.list()) runs.push(await this.refreshRun(run));
    return runs;
  }

  async cancel(runId: string): Promise<StabilityRun | undefined> {
    const run = this.store.get(runId);
    if (!run) return undefined;
    for (const task of run.tasks) {
      if (task.status === "pending" || task.status === "running") this.options.taskManager.cancel(task.taskId);
    }
    const cancelled = await this.refreshRun({ ...run, status: "cancelled", finishedAt: new Date().toISOString() });
    return cancelled;
  }

  private get store(): StabilityRunStore {
    return this.options.store ?? new StabilityRunStore();
  }

  private async refreshRun(run: StabilityRun): Promise<StabilityRun> {
    const tasks = run.tasks.map(task => this.refreshTask(task));
    const summary = summarize(tasks);
    const active = summary.pending + summary.running;
    const status = run.status === "cancelled" ? "cancelled" : active > 0 ? "running" : "completed";
    const updated: StabilityRun = {
      ...run,
      status,
      tasks,
      summary,
      updatedAt: new Date().toISOString(),
      finishedAt: status !== "running" ? run.finishedAt ?? new Date().toISOString() : undefined
    };
    this.store.save(updated);
    return updated;
  }

  private refreshTask(task: StabilityTaskRecord): StabilityTaskRecord {
    const current = this.options.taskManager.get(task.taskId);
    if (!current) return task;
    return {
      ...task,
      status: current.status,
      error: current.error,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      durationMs: terminalStatus(current.status) ? durationMs(current) : undefined
    };
  }
}

function validateInput(input: StabilityRunInput): void {
  if (!input.request.trim()) throw new Error("request is required");
  if (!input.workspaceRoot.trim()) throw new Error("workspaceRoot is required");
  if (input.providers.length === 0) throw new Error("at least one provider is required");
  if (!Number.isInteger(input.iterations) || input.iterations <= 0) throw new Error("iterations must be a positive integer");
}

function createStabilityRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `stability-${date}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildStabilityRequest(request: string, runId: string, provider: AgentName, iteration: number): string {
  return [
    "This is a Codex Claude stability test task.",
    `Run: ${runId}`,
    `Provider: ${provider}`,
    `Iteration: ${iteration}`,
    "Complete the requested work in this isolated workspace. Do not commit.",
    "",
    request
  ].join("\n");
}

function stabilityWorkspaceReadme(runId: string, provider: AgentName, iteration: number): string {
  return [
    `# Stability workspace ${runId}`,
    "",
    `Provider: ${provider}`,
    `Iteration: ${iteration}`,
    ""
  ].join("\n");
}

function summarize(tasks: StabilityTaskRecord[]): StabilityRunSummary {
  const byProvider: Record<string, StabilityProviderSummary> = {};
  for (const task of tasks) {
    byProvider[task.provider] = summarizeTasks(tasks.filter(item => item.provider === task.provider));
  }
  return {
    ...summarizeTasks(tasks),
    byProvider
  };
}

function summarizeTasks(tasks: StabilityTaskRecord[]): StabilityProviderSummary {
  const total = tasks.length;
  const counts = {
    pending: countStatus(tasks, "pending"),
    running: countStatus(tasks, "running"),
    completed: countStatus(tasks, "completed"),
    failed: countStatus(tasks, "failed"),
    cancelled: countStatus(tasks, "cancelled"),
    interrupted: countStatus(tasks, "interrupted")
  };
  const durations = tasks.map(task => task.durationMs).filter((value): value is number => typeof value === "number");
  return {
    total,
    ...counts,
    successRate: total > 0 ? counts.completed / total : 0,
    averageDurationMs: durations.length > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : undefined,
    failureSamples: tasks
      .filter(task => task.status === "failed" || task.status === "interrupted")
      .map(task => [task.provider, `#${task.iteration}`, task.error].filter(Boolean).join(" "))
      .slice(0, 5)
  };
}

function countStatus(tasks: StabilityTaskRecord[], status: TaskStatus): number {
  return tasks.filter(task => task.status === status).length;
}

function terminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function durationMs(task: DelegatedTask): number | undefined {
  const start = Date.parse(task.createdAt);
  const end = Date.parse(task.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function parseRun(content: string): StabilityRun | undefined {
  try {
    const parsed = JSON.parse(content) as StabilityRun;
    if (typeof parsed.id !== "string" || !Array.isArray(parsed.tasks)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
