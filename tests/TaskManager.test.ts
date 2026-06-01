import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../src/agents/AgentProvider.js";
import { AgentCoordinator } from "../src/workflow/AgentCoordinator.js";
import { TaskManager, type TaskManagerOptions } from "../src/workflow/TaskManager.js";
import { TaskStore } from "../src/workflow/TaskStore.js";
import type { AgentName, DelegatedTask, InjectedSkill, StageInput, StageResult } from "../src/types.js";

class SlowProvider implements AgentProvider {
  constructor(readonly name: AgentName) {}

  async run(input: StageInput): Promise<StageResult> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 50);
      input.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });

    return {
      ok: true,
      runId: input.runId ?? "test-run",
      stage: input.stage,
      agent: this.name,
      status: "completed",
      changedFiles: [],
      requiresCodex: false,
      summary: `${this.name} ${input.stage}`
    };
  }
}

describe("TaskManager", () => {
  it("runs sync delegated tasks through the coordinator", async () => {
    const manager = createManager();
    const result = await manager.run({
      mode: "sync",
      workspace: "/tmp/project",
      request: "Plan login cache",
      stages: ["plan"],
      routing: {},
      preferredAgent: "claude",
      runId: "sync-run"
    });

    assert.equal(result.mode, "sync");
    assert.equal(result.result?.ok, true);
    assert.equal(result.result?.results[0].agent, "claude");
  });

  it("starts, reports, and cancels background tasks", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-store-"));
    const manager = createManager(new TaskStore({ rootDir: storeDir }));
    const launched = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement login cache",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "background-run"
    });

    assert.equal(launched.mode, "background");
    assert.ok(launched.taskId);

    const cancelled = manager.cancel(launched.taskId);
    assert.equal(cancelled?.status, "cancelled");

    const status = manager.get(launched.taskId);
    assert.equal(status?.status, "cancelled");
  });

  it("persists background tasks and marks orphaned running tasks as interrupted", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-store-"));
    const store = new TaskStore({ rootDir: storeDir });
    const manager = createManager(store);
    const launched = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement login cache",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "persisted-run"
    });

    assert.ok(launched.taskId);
    const restoredManager = createManager(store);
    const restored = restoredManager.get(launched.taskId);

    assert.equal(restored?.id, launched.taskId);
    assert.equal(restored?.status, "interrupted");
    assert.match(restored?.error ?? "", /interrupted/i);
  });

  it("queues background tasks when max concurrency is reached", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-queue-"));
    const store = new TaskStore({ rootDir: storeDir });
    const manager = createManager(store, { maxRunning: 1 });

    const first = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement first",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "queued-first"
    });
    const second = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement second",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "queued-second"
    });

    assert.equal(manager.get(first.taskId ?? "")?.status, "running");
    assert.equal(manager.get(second.taskId ?? "")?.status, "pending");

    await new Promise(resolve => setTimeout(resolve, 80));

    assert.equal(manager.get(first.taskId ?? "")?.status, "completed");
    assert.equal(manager.get(second.taskId ?? "")?.status, "running");
  });

  it("promotes Claude session id and detailed error from failed background results", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-failed-session-"));
    const coordinator = new AgentCoordinator({
      providers: {
        claude: {
          name: "claude",
          async run(input: StageInput): Promise<StageResult> {
            return {
              ok: false,
              runId: input.runId ?? "failed-session-run",
              stage: input.stage,
              agent: "claude",
              status: "failed",
              agentSessionId: "495bcb7d-c68b-4457-9f86-16775d6c97f9",
              changedFiles: [],
              requiresCodex: false,
              summary: "Claude implement failed",
              error: "API Error: role 'system' is not supported on this model"
            };
          }
        }
      }
    });
    const manager = new TaskManager(coordinator, new TaskStore({ rootDir: storeDir }));

    const launched = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Fix npm test",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "failed-session-run"
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const task = manager.get(launched.taskId ?? "");

    assert.equal(task?.status, "failed");
    assert.equal(task?.agentSessionId, "495bcb7d-c68b-4457-9f86-16775d6c97f9");
    assert.match(task?.error ?? "", /role 'system'/);
  });

  it("runs a verification command after successful background work", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-verify-pass-"));
    const manager = createManager(new TaskStore({ rootDir: storeDir }), undefined, {
      exec: async (command: string) => ({
        code: command === "npm test" ? 0 : 1,
        stdout: "tests passed",
        stderr: "",
        timedOut: false
      })
    });

    const launched = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement login cache",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "verify-pass",
      verifyCommand: "npm test"
    });

    await new Promise(resolve => setTimeout(resolve, 80));
    const task = manager.get(launched.taskId ?? "");

    assert.equal(task?.status, "completed");
    assert.equal(task?.verification?.status, "passed");
    assert.equal(task?.verification?.command, "npm test");
    assert.equal(task?.verification?.stdout, "tests passed");
  });

  it("launches a repair task when verification fails", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-verify-repair-"));
    let verificationRuns = 0;
    const manager = createManager(new TaskStore({ rootDir: storeDir }), undefined, {
      exec: async () => {
        verificationRuns += 1;
        return verificationRuns === 1
          ? { code: 1, stdout: "", stderr: "npm test failed", timedOut: false }
          : { code: 0, stdout: "tests passed after repair", stderr: "", timedOut: false };
      }
    });

    const launched = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement login cache",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "verify-repair",
      verifyCommand: "npm test",
      maxRepairAttempts: 1
    });

    await new Promise(resolve => setTimeout(resolve, 180));
    const source = manager.get(launched.taskId ?? "");
    const repairTaskId = source?.verification?.repairTaskId;
    const repair = repairTaskId ? manager.get(repairTaskId) : undefined;

    assert.equal(source?.status, "failed");
    assert.equal(source?.verification?.status, "failed");
    assert.equal(source?.verification?.stderr, "npm test failed");
    assert.equal(repairTaskId, "verify-repair-repair-1");
    assert.equal(repair?.repairOf, "verify-repair");
    assert.equal(repair?.status, "completed");
    assert.equal(repair?.verification?.status, "passed");
  });

  it("records workflow parent tasks and aggregates child status", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-workflow-"));
    const manager = createManager(new TaskStore({ rootDir: storeDir }));
    const childA = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement child A",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "workflow-child-a",
      parentTaskId: "workflow-parent"
    });
    const childB = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement child B",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "workflow-child-b",
      parentTaskId: "workflow-parent"
    });

    const parent = manager.createWorkflowTask({
      id: "workflow-parent",
      workspace: "/tmp/project",
      request: "Implement workflow",
      planId: "workflow-plan",
      planPath: "/tmp/project/.codex-claude/plans/workflow-plan.md",
      childTaskIds: [String(childA.taskId), String(childB.taskId)]
    });

    assert.equal(parent.status, "running");
    assert.deepEqual(parent.childTaskIds, ["workflow-child-a", "workflow-child-b"]);
    assert.equal(manager.get("workflow-parent")?.status, "running");
    assert.equal(manager.get("workflow-parent")?.workflow?.state?.phase, "executing");

    await new Promise(resolve => setTimeout(resolve, 80));

    const completed = manager.get("workflow-parent");
    assert.equal(completed?.status, "completed");
    assert.deepEqual(completed?.workflow?.summary, { total: 2, completed: 2, failed: 0, running: 0, pending: 0 });
    assert.equal(completed?.workflow?.state?.phase, "completed");
    assert.equal(completed?.workflow?.state?.nextAction.kind, "complete");
    assert.ok(completed?.workflow?.statePath?.includes(".codex-claude/workflows/workflow-parent.json"));
  });

  it("does not retry workflow parent tasks as empty background work", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-workflow-retry-"));
    const manager = createManager(new TaskStore({ rootDir: storeDir }));
    manager.createWorkflowTask({
      id: "workflow-parent-retry",
      workspace: "/tmp/project",
      request: "Implement workflow",
      childTaskIds: ["missing-child"]
    });

    const retried = await manager.retry("workflow-parent-retry");

    assert.equal(retried, undefined);
  });

  it("retries failed workflow parts and creates a new dependent review task", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-workflow-retry-parts-"));
    const store = new TaskStore({ rootDir: storeDir });
    store.save({
      id: "workflow-retry-done",
      mode: "background",
      status: "completed",
      workspace: "/tmp/project",
      request: "Done",
      stages: ["implement"],
      profile: "multi-coder",
      parentTaskId: "workflow-retry-parent",
      runId: "workflow-retry-done",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:01.000Z"
    });
    store.save({
      id: "workflow-retry-failed",
      mode: "background",
      status: "interrupted",
      workspace: "/tmp/project",
      request: "Failed",
      stages: ["implement"],
      profile: "multi-coder",
      parentTaskId: "workflow-retry-parent",
      runId: "workflow-retry-failed",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:01.000Z"
    });
    store.save({
      id: "workflow-retry-review",
      mode: "background",
      status: "interrupted",
      workspace: "/tmp/project",
      request: "Review",
      stages: ["review"],
      profile: "momus",
      parentTaskId: "workflow-retry-parent",
      dependsOnTaskIds: ["workflow-retry-done", "workflow-retry-failed"],
      runId: "workflow-retry-review",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:01.000Z"
    });
    const manager = createManager(store);
    manager.createWorkflowTask({
      id: "workflow-retry-parent",
      workspace: "/tmp/project",
      request: "Workflow",
      childTaskIds: ["workflow-retry-done", "workflow-retry-failed", "workflow-retry-review"],
      reviewTaskId: "workflow-retry-review"
    });

    const retried = await manager.retryFailedWorkflowParts("workflow-retry-parent");

    assert.equal(retried?.status, "running");
    assert.ok(retried?.childTaskIds?.includes("workflow-retry-done"));
    assert.ok(!retried?.childTaskIds?.includes("workflow-retry-failed"));
    assert.ok(!retried?.childTaskIds?.includes("workflow-retry-review"));
    assert.ok(retried?.reviewTaskId);
    const review = manager.get(retried?.reviewTaskId ?? "");
    assert.equal(review?.profile, "momus");
    assert.deepEqual(review?.dependsOnTaskIds, retried?.childTaskIds?.filter(id => id !== retried.reviewTaskId));
    const state = manager.get("workflow-retry-parent")?.workflow?.state;
    assert.equal(state?.phase, "executing");
    assert.deepEqual(state?.steps.map(step => step.taskId), retried?.childTaskIds);
  });

  it("resumes failed workflow parts with Claude sessions before retrying", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-workflow-resume-parts-"));
    const store = new TaskStore({ rootDir: storeDir });
    store.save({
      id: "workflow-resume-failed",
      mode: "background",
      status: "failed",
      workspace: "/tmp/project",
      request: "Continue failed implementation",
      stages: ["implement"],
      profile: "multi-coder",
      preferredAgent: "claude",
      parentTaskId: "workflow-resume-parent",
      agentSessionId: "495bcb7d-c68b-4457-9f86-16775d6c97f9",
      runId: "workflow-resume-failed",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:01.000Z"
    });
    store.save({
      id: "workflow-resume-review",
      mode: "background",
      status: "failed",
      workspace: "/tmp/project",
      request: "Review",
      stages: ["review"],
      profile: "momus",
      parentTaskId: "workflow-resume-parent",
      dependsOnTaskIds: ["workflow-resume-failed"],
      runId: "workflow-resume-review",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:01.000Z"
    });
    const manager = createManager(store);
    manager.createWorkflowTask({
      id: "workflow-resume-parent",
      workspace: "/tmp/project",
      request: "Workflow",
      childTaskIds: ["workflow-resume-failed", "workflow-resume-review"],
      reviewTaskId: "workflow-resume-review"
    });

    const resumed = await manager.retryFailedWorkflowParts("workflow-resume-parent");

    assert.equal(resumed?.status, "running");
    assert.ok(!resumed?.childTaskIds?.includes("workflow-resume-failed"));
    assert.ok(!resumed?.childTaskIds?.includes("workflow-resume-review"));
    const implementationId = resumed?.childTaskIds?.find(id => id !== resumed.reviewTaskId);
    assert.ok(implementationId);
    const implementation = manager.get(implementationId);
    assert.equal(implementation?.resumeOf, "workflow-resume-failed");
    assert.equal(implementation?.retryOf, undefined);
    assert.equal(implementation?.agentSessionId, "495bcb7d-c68b-4457-9f86-16775d6c97f9");
    const review = manager.get(resumed?.reviewTaskId ?? "");
    assert.deepEqual(review?.dependsOnTaskIds, [implementationId]);
  });

  it("adopts manually resumed workflow children into the parent status", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-workflow-adopt-resume-"));
    const store = new TaskStore({ rootDir: storeDir });
    store.save({
      id: "workflow-adopt-failed",
      mode: "background",
      status: "failed",
      workspace: "/tmp/project",
      request: "Continue failed implementation",
      stages: ["implement"],
      profile: "multi-coder",
      preferredAgent: "claude",
      parentTaskId: "workflow-adopt-parent",
      agentSessionId: "495bcb7d-c68b-4457-9f86-16775d6c97f9",
      runId: "workflow-adopt-failed",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:01.000Z"
    });
    const manager = createManager(store);
    manager.createWorkflowTask({
      id: "workflow-adopt-parent",
      workspace: "/tmp/project",
      request: "Workflow",
      childTaskIds: ["workflow-adopt-failed"]
    });

    const resumed = await manager.resume("workflow-adopt-failed");
    const parent = manager.get("workflow-adopt-parent");

    assert.ok(resumed?.taskId);
    assert.deepEqual(parent?.childTaskIds, [resumed?.taskId]);
    assert.equal(parent?.status, "running");
    assert.equal(parent?.workflow?.summary?.running, 1);
  });

  it("starts dependent tasks only after dependencies complete", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-deps-"));
    const manager = createManager(new TaskStore({ rootDir: storeDir }), { maxRunning: 2 });
    const first = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement feature",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "dep-implement"
    });
    const review = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Review feature",
      stages: ["review"],
      routing: {},
      preferredAgent: "codex",
      runId: "dep-review",
      dependsOnTaskIds: [String(first.taskId)]
    });

    assert.equal(manager.get(review.taskId ?? "")?.status, "pending");

    await new Promise(resolve => setTimeout(resolve, 80));

    assert.equal(manager.get(first.taskId ?? "")?.status, "completed");
    assert.equal(manager.get(review.taskId ?? "")?.status, "running");
  });

  it("retries cancelled tasks as new background tasks", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-retry-"));
    const manager = createManager(new TaskStore({ rootDir: storeDir }));
    const launched = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement login cache",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "retry-source"
    });
    manager.cancel(launched.taskId ?? "");

    const retried = await manager.retry("retry-source");

    assert.equal(retried?.mode, "background");
    assert.ok(retried?.taskId);
    assert.notEqual(retried?.taskId, "retry-source");
    assert.equal(retried?.task?.retryOf, "retry-source");
    assert.equal(retried?.task?.request, "Implement login cache");
  });

  it("preserves execution controls when retrying tasks", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-retry-controls-"));
    const manager = createManager(new TaskStore({ rootDir: storeDir }));
    const launched = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement login cache",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "retry-controls-source",
      model: "claude-test-model",
      effort: "high",
      timeoutMs: 12345,
      skills: [{ name: "project-rules", content: "Use project rules." }]
    });
    manager.cancel(launched.taskId ?? "");

    const retried = await manager.retry("retry-controls-source");
    const task = retried?.task as NonNullable<typeof retried>["task"] & {
      model?: string;
      effort?: string;
      timeoutMs?: number;
      skills?: Array<{ name: string; content: string }>;
    };

    assert.equal(task?.model, "claude-test-model");
    assert.equal(task?.effort, "high");
    assert.equal(task?.timeoutMs, 12345);
    assert.deepEqual(task?.skills, [{ name: "project-rules", content: "Use project rules." }]);
  });

  it("resumes tasks with the latest Claude session id", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-resume-"));
    const store = new TaskStore({ rootDir: storeDir });
    store.save({
      id: "resume-source",
      mode: "background",
      status: "failed",
      workspace: "/tmp/project",
      request: "Continue implementation",
      stages: ["implement"],
      preferredAgent: "claude",
      runId: "resume-source",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:01.000Z",
      result: {
        results: [
          {
            agent: "claude",
            agentSessionId: "495bcb7d-c68b-4457-9f86-16775d6c97f9"
          }
        ]
      }
    });
    const manager = createManager(store);

    const resumed = await manager.resume("resume-source");

    assert.equal(resumed?.mode, "background");
    assert.equal(resumed?.task?.resumeOf, "resume-source");
    assert.equal(resumed?.task?.agentSessionId, "495bcb7d-c68b-4457-9f86-16775d6c97f9");
  });

  it("preserves execution controls when resuming tasks", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-resume-controls-"));
    const store = new TaskStore({ rootDir: storeDir });
    const source: DelegatedTask & {
      model?: string;
      effort?: string;
      timeoutMs?: number;
      skills?: InjectedSkill[];
    } = {
      id: "resume-controls-source",
      mode: "background",
      status: "failed",
      workspace: "/tmp/project",
      request: "Continue implementation",
      stages: ["implement"],
      preferredAgent: "claude",
      agentSessionId: "495bcb7d-c68b-4457-9f86-16775d6c97f9",
      runId: "resume-controls-source",
      model: "claude-resume-model",
      effort: "xhigh",
      timeoutMs: 23456,
      skills: [{ name: "html-game", content: "Single file only." }],
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:01.000Z"
    };
    store.save(source);
    const manager = createManager(store);

    const resumed = await manager.resume("resume-controls-source");
    const task = resumed?.task as NonNullable<typeof resumed>["task"] & {
      model?: string;
      effort?: string;
      timeoutMs?: number;
      skills?: Array<{ name: string; content: string }>;
    };

    assert.equal(task?.model, "claude-resume-model");
    assert.equal(task?.effort, "xhigh");
    assert.equal(task?.timeoutMs, 23456);
    assert.deepEqual(task?.skills, [{ name: "html-game", content: "Single file only." }]);
  });
});

function createManager(
  store?: TaskStore,
  concurrency?: { maxRunning?: number },
  verification?: TaskManagerOptions["verification"]
): TaskManager {
  const coordinator = new AgentCoordinator({
    providers: {
      claude: new SlowProvider("claude"),
      codex: new SlowProvider("codex")
    }
  });
  return new TaskManager(coordinator, store, { concurrency, verification });
}
