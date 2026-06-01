import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DelegatedTask, TaskStatus, WorkflowLearning, WorkflowNextAction, WorkflowPhase, WorkflowState, WorkflowStepState } from "../types.js";
import { parsePlanChecklist } from "./PlanParser.js";

export interface CreateWorkflowStateInput {
  workflowId: string;
  request: string;
  planId?: string;
  planPath?: string;
  childTaskIds: string[];
  reviewTaskId?: string;
}

export class WorkflowStateStore {
  constructor(private readonly workspace: string) {}

  stateDir(): string {
    return join(this.workspace, ".codex-claude", "workflows");
  }

  statePath(workflowId: string): string {
    return join(this.stateDir(), `${safeId(workflowId)}.json`);
  }

  create(input: CreateWorkflowStateInput): WorkflowState {
    const existing = this.get(input.workflowId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const state: WorkflowState = {
      workflowId: input.workflowId,
      request: input.request,
      phase: "executing",
      planId: input.planId,
      planPath: input.planPath,
      statePath: this.statePath(input.workflowId),
      childTaskIds: input.childTaskIds,
      reviewTaskId: input.reviewTaskId,
      steps: buildInitialSteps(input),
      learnings: [],
      nextAction: {
        kind: "wait",
        reason: "Waiting for workflow tasks to finish."
      },
      createdAt: now,
      updatedAt: now
    };
    this.save(state);
    return state;
  }

  get(workflowId: string): WorkflowState | undefined {
    const path = this.statePath(workflowId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as WorkflowState;
    } catch {
      return undefined;
    }
  }

  updateFromTasks(
    workflowId: string,
    tasks: DelegatedTask[],
    options: Partial<Pick<CreateWorkflowStateInput, "request" | "planId" | "planPath" | "childTaskIds" | "reviewTaskId">> = {}
  ): WorkflowState {
    const state = this.get(workflowId) ?? this.create({
      workflowId,
      request: options.request ?? "",
      planId: options.planId,
      planPath: options.planPath,
      childTaskIds: options.childTaskIds ?? tasks.map(task => task.id),
      reviewTaskId: options.reviewTaskId
    });
    const reconciled = reconcileSteps(state, {
      childTaskIds: options.childTaskIds ?? state.childTaskIds,
      reviewTaskId: options.reviewTaskId ?? state.reviewTaskId,
      planPath: options.planPath ?? state.planPath
    });
    const byId = new Map(tasks.map(task => [task.id, task]));
    const steps: WorkflowStepState[] = reconciled.steps.map(step => ({
      ...step,
      status: byId.get(step.taskId)?.status ?? "missing"
    }));
    const reviewTaskId = options.reviewTaskId ?? state.reviewTaskId;
    const phase = phaseFor(steps, reviewTaskId);
    const updated: WorkflowState = {
      ...reconciled,
      request: options.request ?? reconciled.request,
      planId: options.planId ?? reconciled.planId,
      planPath: options.planPath ?? reconciled.planPath,
      childTaskIds: options.childTaskIds ?? reconciled.childTaskIds,
      reviewTaskId,
      phase,
      steps,
      learnings: mergeLearnings(state.learnings, tasks),
      nextAction: nextActionFor(phase, steps),
      updatedAt: new Date().toISOString()
    };
    this.save(updated);
    return updated;
  }

  private save(state: WorkflowState): void {
    mkdirSync(this.stateDir(), { recursive: true });
    const tempPath = `${state.statePath}.tmp-${process.pid}`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, state.statePath);
  }
}

function reconcileSteps(
  state: WorkflowState,
  input: Pick<CreateWorkflowStateInput, "childTaskIds" | "reviewTaskId" | "planPath">
): WorkflowState {
  const existing = new Map(state.steps.map(step => [step.taskId, step]));
  const planSteps = input.planPath && existsSync(input.planPath)
    ? parsePlanChecklist(readFileSync(input.planPath, "utf8")).steps
    : [];
  const steps: WorkflowStepState[] = [];
  let implementationIndex = 0;
  for (const taskId of input.childTaskIds) {
    const isReview = taskId === input.reviewTaskId;
    const existingStep = existing.get(taskId);
    if (existingStep) {
      steps.push({ ...existingStep, kind: isReview ? "review" : existingStep.kind });
      if (!isReview) implementationIndex += 1;
      continue;
    }
    if (isReview) {
      steps.push({
        id: "review",
        text: "Review completed workflow work",
        kind: "review",
        taskId,
        status: "pending"
      });
      continue;
    }
    const planStep = planSteps[implementationIndex];
    steps.push({
      id: `step-${implementationIndex + 1}`,
      text: planStep?.text ?? `Execute workflow task ${implementationIndex + 1}`,
      kind: "task",
      taskId,
      status: "pending",
      line: planStep?.line
    });
    implementationIndex += 1;
  }
  return {
    ...state,
    childTaskIds: input.childTaskIds,
    reviewTaskId: input.reviewTaskId,
    planPath: input.planPath ?? state.planPath,
    steps
  };
}

function buildInitialSteps(input: CreateWorkflowStateInput): WorkflowStepState[] {
  const planSteps = input.planPath && existsSync(input.planPath)
    ? parsePlanChecklist(readFileSync(input.planPath, "utf8")).steps
    : [];
  const implementationIds = input.childTaskIds.filter(id => id !== input.reviewTaskId);
  const steps: WorkflowStepState[] = implementationIds.map((taskId, index) => ({
    id: `step-${index + 1}`,
    text: planSteps[index]?.text ?? `Execute workflow task ${index + 1}`,
    kind: "task",
    taskId,
    status: "pending",
    line: planSteps[index]?.line
  }));
  if (input.reviewTaskId) {
    steps.push({
      id: "review",
      text: "Review completed workflow work",
      kind: "review",
      taskId: input.reviewTaskId,
      status: "pending"
    });
  }
  return steps;
}

function phaseFor(steps: WorkflowStepState[], reviewTaskId?: string): WorkflowPhase {
  const statuses = steps.map(step => step.status);
  if (statuses.includes("cancelled")) return "cancelled";
  if (statuses.includes("interrupted")) return "interrupted";
  if (statuses.includes("failed") || statuses.includes("missing")) return "failed";
  const implementationSteps = steps.filter(step => step.taskId !== reviewTaskId);
  const reviewStep = steps.find(step => step.taskId === reviewTaskId);
  if (implementationSteps.some(step => step.status !== "completed")) return "executing";
  if (reviewStep && reviewStep.status !== "completed") return "reviewing";
  return "completed";
}

function nextActionFor(phase: WorkflowPhase, steps: WorkflowStepState[]): WorkflowNextAction {
  if (phase === "completed") {
    return { kind: "complete", reason: "All implementation and review tasks completed." };
  }
  if (phase === "failed" || phase === "interrupted") {
    const taskIds = steps
      .filter(step => step.status === "failed" || step.status === "interrupted" || step.status === "missing")
      .map(step => step.taskId);
    return {
      kind: phase === "interrupted" ? "resume" : "retry_failed_parts",
      reason: phase === "interrupted" ? "One or more workflow tasks were interrupted." : "One or more workflow tasks failed.",
      taskIds
    };
  }
  if (phase === "cancelled") {
    return { kind: "cancelled", reason: "Workflow was cancelled." };
  }
  return { kind: "wait", reason: phase === "reviewing" ? "Waiting for review to finish." : "Waiting for implementation tasks to finish." };
}

function mergeLearnings(existing: WorkflowLearning[], tasks: DelegatedTask[]): WorkflowLearning[] {
  const byTask = new Map(existing.map(learning => [learning.taskId, learning]));
  for (const task of tasks) {
    if (task.status !== "completed") continue;
    const summary = taskSummary(task);
    if (!summary) continue;
    byTask.set(task.id, {
      taskId: task.id,
      summary,
      changedFiles: taskChangedFiles(task)
    });
  }
  return [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function taskSummary(task: DelegatedTask): string {
  const results = stageResults(task);
  return results.map(result => result.summary).filter(Boolean).join("\n") || task.error || "";
}

function taskChangedFiles(task: DelegatedTask): string[] {
  return [...new Set(stageResults(task).flatMap(result => result.changedFiles ?? []))];
}

function stageResults(task: DelegatedTask): Array<{ summary?: string; changedFiles?: string[] }> {
  const maybeResults = (task.result as { results?: unknown } | undefined)?.results;
  return Array.isArray(maybeResults)
    ? maybeResults.filter((result): result is { summary?: string; changedFiles?: string[] } => typeof result === "object" && result !== null)
    : [];
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
