import type { AgentName, AgentProfileName, DelegatedTask, Stage, TaskCategory, TaskMode } from "../types.js";
import type { CoordinatorResult } from "./AgentCoordinator.js";
import { AgentCoordinator, type CoordinatorInput } from "./AgentCoordinator.js";

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
  model?: string;
  effort?: CoordinatorInput["effort"];
  timeoutMs?: number;
}

export interface DelegateTaskResult {
  mode: TaskMode;
  taskId?: string;
  task?: DelegatedTask;
  result?: CoordinatorResult;
}

interface StoredTask extends DelegatedTask {
  controller: AbortController;
}

export class TaskManager {
  private readonly tasks = new Map<string, StoredTask>();

  constructor(private readonly coordinator: AgentCoordinator) {}

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
        model: input.model,
        effort: input.effort,
        timeoutMs: input.timeoutMs
      });
      return { mode: "sync", result };
    }

    const task = this.createTask(input);
    this.tasks.set(task.id, task);
    void this.startBackgroundTask(task, input);
    return { mode: "background", taskId: task.id, task: publicTask(task) };
  }

  get(taskId: string): DelegatedTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? publicTask(task) : undefined;
  }

  list(): DelegatedTask[] {
    return [...this.tasks.values()].map(publicTask);
  }

  cancel(taskId: string): DelegatedTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      return publicTask(task);
    }
    task.controller.abort();
    task.status = "cancelled";
    task.updatedAt = new Date().toISOString();
    task.error = "Task cancelled";
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
      runId: id,
      createdAt: now,
      updatedAt: now,
      controller: new AbortController()
    };
  }

  private async startBackgroundTask(task: StoredTask, input: DelegateTaskInput): Promise<void> {
    task.status = "running";
    task.updatedAt = new Date().toISOString();
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
        model: input.model,
        effort: input.effort,
        timeoutMs: input.timeoutMs,
        signal: task.controller.signal
      });
      if (isCancelled(task)) return;
      task.status = result.ok ? "completed" : "failed";
      task.result = result;
      task.error = result.ok ? undefined : result.summary;
      task.updatedAt = new Date().toISOString();
    } catch (error) {
      if (isCancelled(task)) return;
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
    }
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
  const { controller: _controller, ...publicFields } = task;
  return publicFields;
}
