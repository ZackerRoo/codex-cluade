import type { AgentName, AgentProfileName, DelegatedTask, InjectedSkill, Stage, TaskCategory, TaskMode, TaskStatus, VerificationResult } from "../types.js";
import type { CoordinatorResult } from "./AgentCoordinator.js";
import { AgentCoordinator, type CoordinatorInput } from "./AgentCoordinator.js";
import { isLiveStatus, TaskStore } from "./TaskStore.js";
import { WorkflowStateStore } from "./WorkflowStateStore.js";
import { execShellCapture, type ExecResult } from "../utils/exec.js";

type VerificationExec = (command: string, options: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<ExecResult>;

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
  parentTaskId?: string;
  dependsOnTaskIds?: string[];
  retryOf?: string;
  resumeOf?: string;
  repairOf?: string;
  verifyCommand?: string;
  maxRepairAttempts?: number;
  repairAttempt?: number;
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

export interface WorkflowTaskInput {
  id: string;
  workspace: string;
  request: string;
  planId?: string;
  planPath?: string;
  childTaskIds: string[];
  reviewTaskId?: string;
  verifyCommand?: string;
  maxRepairAttempts?: number;
}

export interface TaskManagerOptions {
  concurrency?: {
    maxRunning?: number;
  };
  verification?: {
    exec?: VerificationExec;
    timeoutMs?: number;
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
    if (task) return this.withWorkflowStatus(withDerivedTaskMetadata(publicTask(task)));
    const stored = this.store.get(taskId);
    if (!stored) return undefined;
    return this.interruptIfOrphaned(this.withWorkflowStatus(withDerivedTaskMetadata(stored)));
  }

  list(): DelegatedTask[] {
    const memoryTasks = new Map([...this.tasks.values()].map(task => [task.id, this.withWorkflowStatus(withDerivedTaskMetadata(publicTask(task)))]));
    const storedTasks = this.store.list().map(task => {
      const memoryTask = memoryTasks.get(task.id);
      return memoryTask ?? this.interruptIfOrphaned(withDerivedTaskMetadata(task));
    });
    for (const task of memoryTasks.values()) {
      if (!storedTasks.some(stored => stored.id === task.id)) storedTasks.push(task);
    }
    return storedTasks.map(task => this.withWorkflowStatus(task)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createWorkflowTask(input: WorkflowTaskInput): DelegatedTask {
    const now = new Date().toISOString();
    const task: DelegatedTask = {
      id: input.id,
      kind: "workflow",
      mode: "background",
      status: "running",
      workspace: input.workspace,
      request: input.request,
      stages: [],
      planId: input.planId,
      planPath: input.planPath,
      childTaskIds: input.childTaskIds,
      reviewTaskId: input.reviewTaskId,
      verifyCommand: input.verifyCommand,
      maxRepairAttempts: input.maxRepairAttempts,
      workflow: {
        kind: "ultrawork",
        state: new WorkflowStateStore(input.workspace).create({
          workflowId: input.id,
          request: input.request,
          planId: input.planId,
          planPath: input.planPath,
          childTaskIds: input.childTaskIds,
          reviewTaskId: input.reviewTaskId
        })
      },
      runId: input.id,
      createdAt: now,
      updatedAt: now
    };
    const summarized = this.withWorkflowStatus(task);
    this.store.save(summarized);
    return summarized;
  }

  cancel(taskId: string): DelegatedTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) {
      const stored = this.store.get(taskId);
      if (stored?.kind === "workflow") {
        for (const childTaskId of stored.childTaskIds ?? []) this.cancel(childTaskId);
        const cancelled: DelegatedTask = {
          ...stored,
          status: "cancelled",
          updatedAt: new Date().toISOString(),
          error: "Workflow cancelled"
        };
        this.store.save(cancelled);
        return cancelled;
      }
      return this.get(taskId);
    }
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

  async retry(taskId: string): Promise<DelegateTaskResult | undefined> {
    const task = this.get(taskId);
    if (!task) return undefined;
    if (task.kind === "workflow") return undefined;
    return await this.run({
      mode: "background",
      workspace: task.workspace,
      request: task.request,
      stages: task.stages,
      routing: {},
      category: task.category,
      profile: task.profile,
      preferredAgent: task.preferredAgent,
      planId: task.planId,
      planPath: task.planPath,
      parentTaskId: task.parentTaskId,
      dependsOnTaskIds: task.dependsOnTaskIds,
      model: task.model,
      effort: task.effort,
      timeoutMs: task.timeoutMs,
      skills: task.skills,
      verifyCommand: task.verifyCommand,
      maxRepairAttempts: task.maxRepairAttempts,
      repairAttempt: task.repairAttempt,
      retryOf: task.id
    });
  }

  async retryFailedWorkflowParts(taskId: string): Promise<DelegatedTask | undefined> {
    const workflow = this.get(taskId);
    if (!workflow || workflow.kind !== "workflow") return undefined;
    const childTaskIds = workflow.childTaskIds ?? [];
    const previousReview = workflow.reviewTaskId ? this.get(workflow.reviewTaskId) : undefined;
    const implementationIds: string[] = [];
    for (const childTaskId of childTaskIds) {
      if (childTaskId === workflow.reviewTaskId) continue;
      const child = this.get(childTaskId);
      if (!child) continue;
      if (child.status === "completed") {
        implementationIds.push(child.id);
        continue;
      }
      const resumed = await this.resume(child.id);
      if (resumed?.taskId) {
        implementationIds.push(resumed.taskId);
        continue;
      }
      const retry = await this.retry(child.id);
      if (retry?.taskId) implementationIds.push(retry.taskId);
    }

    let reviewTaskId = workflow.reviewTaskId;
    if (previousReview) {
      const review = await this.run({
        mode: "background",
        workspace: previousReview.workspace,
        request: previousReview.request,
        stages: previousReview.stages,
        routing: {},
        category: previousReview.category,
        profile: previousReview.profile,
        preferredAgent: previousReview.preferredAgent,
        planId: previousReview.planId,
        planPath: previousReview.planPath,
        parentTaskId: workflow.id,
        dependsOnTaskIds: implementationIds,
        model: previousReview.model,
        effort: previousReview.effort,
      timeoutMs: previousReview.timeoutMs,
      skills: previousReview.skills,
      retryOf: previousReview.id
      });
      reviewTaskId = review.taskId;
    }

    const updated: DelegatedTask = {
      ...workflow,
      status: "running",
      childTaskIds: [...implementationIds, ...(reviewTaskId ? [reviewTaskId] : [])],
      reviewTaskId,
      error: undefined,
      updatedAt: new Date().toISOString()
    };
    this.store.save(updated);
    return this.withWorkflowStatus(updated);
  }

  async resume(taskId: string): Promise<DelegateTaskResult | undefined> {
    const task = this.get(taskId);
    if (!task) return undefined;
    const agentSessionId = task.agentSessionId ?? latestClaudeSessionId(task);
    if (!agentSessionId) return undefined;
    return await this.run({
      mode: "background",
      workspace: task.workspace,
      request: task.request,
      stages: task.stages,
      routing: {},
      category: task.category,
      profile: task.profile,
      preferredAgent: task.preferredAgent,
      agentSessionId,
      planId: task.planId,
      planPath: task.planPath,
      parentTaskId: task.parentTaskId,
      dependsOnTaskIds: task.dependsOnTaskIds,
      model: task.model,
      effort: task.effort,
      timeoutMs: task.timeoutMs,
      skills: task.skills,
      verifyCommand: task.verifyCommand,
      maxRepairAttempts: task.maxRepairAttempts,
      repairAttempt: task.repairAttempt,
      resumeOf: task.id
    });
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
      parentTaskId: input.parentTaskId,
      dependsOnTaskIds: input.dependsOnTaskIds,
      model: input.model,
      effort: input.effort,
      timeoutMs: input.timeoutMs,
      skills: input.skills,
      retryOf: input.retryOf,
      resumeOf: input.resumeOf,
      repairOf: input.repairOf,
      verifyCommand: input.verifyCommand,
      maxRepairAttempts: input.maxRepairAttempts,
      repairAttempt: input.repairAttempt,
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
      task.agentSessionId = latestClaudeSessionId({ ...task, result }) ?? task.agentSessionId;
      task.error = result.ok ? undefined : latestStageError({ ...task, result }) ?? result.summary;
      task.updatedAt = new Date().toISOString();
      if (result.ok && task.verifyCommand) {
        task.status = "running";
        task.verification = startVerification(task.verifyCommand);
        this.saveTask(task);
        await this.finishVerification(task, input);
        this.processQueue();
        return;
      }
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
      if (!this.dependenciesReady(task)) continue;
      running += 1;
      void this.startBackgroundTask(task, task.input);
    }
  }

  private interruptIfOrphaned(task: DelegatedTask): DelegatedTask {
    if (task.kind === "workflow") return task;
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

  private saveDelegatedTask(task: DelegatedTask): void {
    const memoryTask = this.tasks.get(task.id);
    if (memoryTask) {
      Object.assign(memoryTask, task);
      this.saveTask(memoryTask);
      return;
    }
    this.store.save(task);
  }

  private dependenciesReady(task: StoredTask): boolean {
    const dependencies = task.dependsOnTaskIds ?? [];
    if (dependencies.length === 0) return true;
    const states = dependencies.map(id => ({ id, status: this.get(id)?.status }));
    const failed = states.filter(state => state.status === "failed" || state.status === "cancelled" || state.status === "interrupted" || state.status === undefined);
    if (failed.length > 0) {
      task.status = "failed";
      task.error = `Task dependency failed: ${failed.map(state => `${state.id}(${state.status ?? "missing"})`).join(", ")}`;
      task.updatedAt = new Date().toISOString();
      this.saveTask(task);
      return false;
    }
    return states.every(state => state.status === "completed");
  }

  private withWorkflowStatus(task: DelegatedTask): DelegatedTask {
    if (task.kind !== "workflow" || !task.childTaskIds || task.childTaskIds.length === 0) return task;
    const { childTaskIds, reviewTaskId } = this.resolveWorkflowChildReplacements(task);
    const children = childTaskIds.map(id => this.rawTask(id)).filter((child): child is DelegatedTask => Boolean(child));
    const summary = {
      total: childTaskIds.length,
      completed: children.filter(child => child.status === "completed").length,
      failed: children.filter(child => child.status === "failed" || child.status === "cancelled" || child.status === "interrupted").length,
      running: children.filter(child => child.status === "running").length,
      pending: children.filter(child => child.status === "pending").length
    };
    const status: TaskStatus = summary.failed > 0
      ? "failed"
      : summary.completed === summary.total
        ? "completed"
        : "running";
    const workflowState = new WorkflowStateStore(task.workspace).updateFromTasks(task.id, children, {
        request: task.request,
        planId: task.planId,
        planPath: task.planPath,
        childTaskIds,
        reviewTaskId
      });
    let updated: DelegatedTask = {
      ...task,
      childTaskIds,
      reviewTaskId,
      status: workflowStatus(task, status),
      workflow: {
        kind: "ultrawork" as const,
        summary,
        statePath: workflowState.statePath,
        state: workflowState
      },
      updatedAt: status === task.status ? task.updatedAt : new Date().toISOString()
    };
    if (updated.status === "completed" && updated.verifyCommand && !updated.verification) {
      updated = {
        ...updated,
        status: "running",
        verification: startVerification(updated.verifyCommand),
        updatedAt: new Date().toISOString()
      };
      this.store.save(updated);
      void this.finishVerification(updated);
      return updated;
    }
    if (updated.status !== task.status || JSON.stringify(updated.workflow) !== JSON.stringify(task.workflow)) this.store.save(updated);
    return updated;
  }

  private resolveWorkflowChildReplacements(task: DelegatedTask): { childTaskIds: string[]; reviewTaskId?: string } {
    const childTaskIds = (task.childTaskIds ?? []).map(id => this.latestReplacementId(id, task.id));
    const reviewTaskId = task.reviewTaskId ? this.latestReplacementId(task.reviewTaskId, task.id) : undefined;
    return { childTaskIds, reviewTaskId };
  }

  private latestReplacementId(taskId: string, parentTaskId: string): string {
    let current = taskId;
    for (let depth = 0; depth < 20; depth += 1) {
      const replacement = this.listRawTasks()
        .filter(task => task.parentTaskId === parentTaskId && (task.resumeOf === current || task.retryOf === current))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!replacement || replacement.id === current) return current;
      current = replacement.id;
    }
    return current;
  }

  private rawTask(taskId: string): DelegatedTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? publicTask(task) : this.store.get(taskId);
  }

  private listRawTasks(): DelegatedTask[] {
    const tasks = new Map(this.store.list().map(task => [task.id, task]));
    for (const task of this.tasks.values()) tasks.set(task.id, publicTask(task));
    return [...tasks.values()];
  }

  private async finishVerification(task: DelegatedTask, input?: DelegateTaskInput): Promise<void> {
    const command = task.verifyCommand;
    if (!command) return;
    const startedAt = task.verification?.startedAt ?? new Date().toISOString();
    let result: ExecResult;
    try {
      result = await (this.options.verification?.exec ?? execShellCapture)(command, {
        cwd: task.workspace,
        timeoutMs: this.options.verification?.timeoutMs ?? 5 * 60 * 1000
      });
    } catch (error) {
      result = {
        code: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false
      };
    }
    const passed = !result.timedOut && result.code === 0;
    const verification: VerificationResult = {
      command,
      status: passed ? "passed" : "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.code,
      timedOut: result.timedOut,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
      error: passed ? undefined : verificationError(result)
    };
    const nextTask: DelegatedTask = {
      ...task,
      status: passed ? "completed" : "failed",
      verification,
      error: passed ? undefined : `Verification failed: ${verification.error}`,
      updatedAt: new Date().toISOString()
    };

    if (!passed) {
      const repair = await this.maybeLaunchRepair(nextTask, input);
      if (repair.taskId) {
        nextTask.verification = { ...verification, repairTaskId: repair.taskId };
        nextTask.error = `Verification failed; repair task launched: ${repair.taskId}`;
      }
    }

    this.saveDelegatedTask(nextTask);
  }

  private async maybeLaunchRepair(task: DelegatedTask, input?: DelegateTaskInput): Promise<{ taskId?: string }> {
    const maxRepairAttempts = task.maxRepairAttempts ?? 1;
    const repairAttempt = task.repairAttempt ?? 0;
    if (!task.verifyCommand || repairAttempt >= maxRepairAttempts) return {};
    const nextAttempt = repairAttempt + 1;
    const repair = await this.run({
      mode: "background",
      workspace: task.workspace,
      request: buildRepairRequest(task),
      stages: input?.stages && input.stages.length > 0 ? input.stages : ["implement"],
      routing: input?.routing ?? {},
      category: input?.category ?? task.category,
      profile: input?.profile ?? task.profile ?? (task.kind === "workflow" ? "multi-coder" : "coder"),
      preferredAgent: input?.preferredAgent ?? task.preferredAgent,
      planId: task.planId,
      planPath: task.planPath,
      parentTaskId: task.kind === "workflow" ? task.id : task.parentTaskId,
      runId: `${task.id}-repair-${nextAttempt}`,
      model: input?.model ?? task.model,
      effort: input?.effort ?? task.effort,
      timeoutMs: input?.timeoutMs ?? task.timeoutMs,
      skills: input?.skills ?? task.skills,
      verifyCommand: task.verifyCommand,
      maxRepairAttempts,
      repairAttempt: nextAttempt,
      repairOf: task.id
    });
    return { taskId: repair.taskId };
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

function startVerification(command: string): VerificationResult {
  return {
    command,
    status: "running",
    startedAt: new Date().toISOString()
  };
}

function workflowStatus(task: DelegatedTask, childStatus: TaskStatus): TaskStatus {
  if (!task.verifyCommand) return childStatus;
  if (task.verification?.status === "passed") return childStatus;
  if (task.verification?.status === "failed") return "failed";
  if (task.verification?.status === "running") return "running";
  return childStatus;
}

function verificationError(result: ExecResult): string {
  if (result.timedOut) return "verification command timed out";
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return detail;
}

function truncateOutput(output: string, maxBytes = 12_000): string {
  if (output.length <= maxBytes) return output;
  return `${output.slice(0, maxBytes)}\n...[truncated ${output.length - maxBytes} bytes]`;
}

function buildRepairRequest(task: DelegatedTask): string {
  const verification = task.verification;
  return [
    "A verification command failed after a delegated task. Repair the workspace so verification passes.",
    "",
    `Original task: ${task.id}`,
    `Original request: ${task.request}`,
    task.planPath ? `Plan path: ${task.planPath}` : "",
    `Verification command: ${task.verifyCommand}`,
    verification?.exitCode !== undefined ? `Exit code: ${verification.exitCode}` : "",
    verification?.stderr ? `stderr:\n${verification.stderr}` : "",
    verification?.stdout ? `stdout:\n${verification.stdout}` : "",
    "",
    "Keep changes scoped. Do not commit. Run the verification command before finishing."
  ].filter(Boolean).join("\n");
}

function withDerivedTaskMetadata(task: DelegatedTask): DelegatedTask {
  const agentSessionId = task.agentSessionId ?? latestClaudeSessionId(task);
  const error = task.status === "failed" ? latestStageError(task) ?? task.error : task.error;
  if (agentSessionId === task.agentSessionId && error === task.error) return task;
  return {
    ...task,
    agentSessionId,
    error
  };
}

function latestClaudeSessionId(task: DelegatedTask): string | undefined {
  const maybeResults = (task.result as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(maybeResults)) return undefined;
  for (const result of [...maybeResults].reverse()) {
    if (
      typeof result === "object" &&
      result !== null &&
      (result as { agent?: unknown }).agent === "claude" &&
      typeof (result as { agentSessionId?: unknown }).agentSessionId === "string"
    ) {
      return (result as { agentSessionId: string }).agentSessionId;
    }
  }
  return undefined;
}

function latestStageError(task: DelegatedTask): string | undefined {
  const maybeResults = (task.result as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(maybeResults)) return undefined;
  for (const result of [...maybeResults].reverse()) {
    if (
      typeof result === "object" &&
      result !== null &&
      (result as { ok?: unknown }).ok === false &&
      typeof (result as { error?: unknown }).error === "string"
    ) {
      return (result as { error: string }).error;
    }
  }
  return undefined;
}
