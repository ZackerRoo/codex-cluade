import type { AgentName, AgentProfileName, DelegatedTask, InjectedSkill, Stage, TaskCategory, TaskMode } from "../types.js";
import type { CoordinatorResult } from "./AgentCoordinator.js";
import { AgentCoordinator, type CoordinatorInput } from "./AgentCoordinator.js";
import { isLiveStatus, TaskStore } from "./TaskStore.js";

export interface DelegateTaskInput {
  mode: TaskMode;
  workspace: string;
  request: string;
  stages: Stage[];
  routing: CoordinatorInput["routing"];
  category?: TaskCategory;
  profile?: AgentProfileName;
  autoCategory?: boolean;
  preferredAgent?: AgentName;
  runId?: string;
  agentSessionId?: string;
  planId?: string;
  planPath?: string;
  model?: string;
  effort?: CoordinatorInput["effort"];
  timeoutMs?: number;
  skills?: InjectedSkill[];
}

export interface DelegateTaskResult {
  mode: TaskMode;
  taskId?: string;
  task?: DelegatedTask;
  result?: CoordinatorResult;
}

export interface TaskManagerOptions {
  concurrency?: {
    maxRunning?: number;
  };
}

interface StoredTask extends DelegatedTask {
  controller: AbortController;
  input?: DelegateTaskInput;
}

export class TaskManager {
  private readonly tasks = new Map<string, StoredTask>();

  constructor(
    private readonly coordinator: AgentCoordinator,
    private readonly store = new TaskStore(),
    private readonly options: TaskManagerOptions = {}
  ) {}

  async run(input: DelegateTaskInput): Promise<DelegateTaskResult> {
    if (input.mode === "sync") {
      const result = await this.coordinator.run({
        workspace: input.workspace,
        request: input.request,
        stages: input.stages,
        routing: input.routing,
        category: input.category,
        profile: input.profile,
        autoCategory: input.autoCategory,
        preferredAgent: input.preferredAgent,
        runId: input.runId,
        agentSessionId: input.agentSessionId,
        model: input.model,
        effort: input.effort,
        timeoutMs: input.timeoutMs,
        skills: input.skills
      });
      return { mode: "sync", result };
    }

    const task = this.createTask(input);
    task.input = input;
    this.tasks.set(task.id, task);
    this.saveTask(task);
    this.processQueue();
    return { mode: "background", taskId: task.id, task: publicTask(task) };
  }

  get(taskId: string): DelegatedTask | undefined {
    const task = this.tasks.get(taskId);
    if (task) return publicTask(task);
    const stored = this.store.get(taskId);
    if (!stored) return undefined;
    return this.interruptIfOrphaned(stored);
  }

  list(): DelegatedTask[] {
    const memoryTasks = new Map([...this.tasks.values()].map(task => [task.id, publicTask(task)]));
    const storedTasks = this.store.list().map(task => {
      const memoryTask = memoryTasks.get(task.id);
      return memoryTask ?? this.interruptIfOrphaned(task);
    });
    for (const task of memoryTasks.values()) {
      if (!storedTasks.some(stored => stored.id === task.id)) storedTasks.push(task);
    }
    return storedTasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  cancel(taskId: string): DelegatedTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return this.get(taskId);
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "interrupted") {
      return publicTask(task);
    }
    task.controller.abort();
    task.status = "cancelled";
    task.updatedAt = new Date().toISOString();
    task.error = "Task cancelled";
    this.saveTask(task);
    this.processQueue();
    return publicTask(task);
  }

  private createTask(input: DelegateTaskInput): StoredTask {
    const now = new Date().toISOString();
    const id = input.runId ?? createTaskId();
    return {
      id,
      mode: input.mode,
      status: "pending",
      workspace: input.workspace,
      request: input.request,
      stages: input.stages,
      category: input.category,
      profile: input.profile,
      preferredAgent: input.preferredAgent,
      agentSessionId: input.agentSessionId,
      planId: input.planId,
      planPath: input.planPath,
      runId: id,
      createdAt: now,
      updatedAt: now,
      controller: new AbortController()
    };
  }

  private async startBackgroundTask(task: StoredTask, input: DelegateTaskInput): Promise<void> {
    task.status = "running";
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);
    try {
      const result = await this.coordinator.run({
        workspace: input.workspace,
        request: input.request,
        stages: input.stages,
        routing: input.routing,
        category: input.category,
        profile: input.profile,
        autoCategory: input.autoCategory,
        preferredAgent: input.preferredAgent,
        runId: task.runId,
        agentSessionId: input.agentSessionId,
        model: input.model,
        effort: input.effort,
        timeoutMs: input.timeoutMs,
        skills: input.skills,
        signal: task.controller.signal
      });
      if (isCancelled(task)) return;
      task.status = result.ok ? "completed" : "failed";
      task.result = result;
      task.error = result.ok ? undefined : result.summary;
      task.updatedAt = new Date().toISOString();
      this.saveTask(task);
      this.processQueue();
    } catch (error) {
      if (isCancelled(task)) return;
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
      this.saveTask(task);
      this.processQueue();
    }
  }

  private processQueue(): void {
    const maxRunning = this.options.concurrency?.maxRunning ?? Number.POSITIVE_INFINITY;
    let running = [...this.tasks.values()].filter(task => task.status === "running").length;
    for (const task of this.tasks.values()) {
      if (running >= maxRunning) return;
      if (task.status !== "pending" || !task.input) continue;
      running += 1;
      void this.startBackgroundTask(task, task.input);
    }
  }

  private interruptIfOrphaned(task: DelegatedTask): DelegatedTask {
    if (!isLiveStatus(task.status)) return task;
    const interrupted: DelegatedTask = {
      ...task,
      status: "interrupted",
      updatedAt: new Date().toISOString(),
      error: task.error ?? "Task interrupted because the MCP server process restarted."
    };
    this.store.save(interrupted);
    return interrupted;
  }

  private saveTask(task: StoredTask): void {
    this.store.save(publicTask(task));
  }
}

function createTaskId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${date}-${suffix}`;
}

function isCancelled(task: StoredTask): boolean {
  return task.status === "cancelled";
}

function publicTask(task: StoredTask): DelegatedTask {
  const { controller: _controller, input: _input, ...publicFields } = task;
  return publicFields;
}
