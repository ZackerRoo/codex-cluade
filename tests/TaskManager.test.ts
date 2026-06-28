import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentProvider } from "../src/agents/AgentProvider.js";
import { AgentCoordinator } from "../src/workflow/AgentCoordinator.js";
import { TaskManager, type TaskManagerOptions } from "../src/workflow/TaskManager.js";
import { TaskStore } from "../src/workflow/TaskStore.js";
import type { AgentName, DelegatedTask, InjectedSkill, StageInput, StageResult } from "../src/types.js";

const execFile = promisify(execFileCallback);

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

  it("limits concurrent implementation children within a workflow", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-workflow-queue-"));
    const store = new TaskStore({ rootDir: storeDir });
    const manager = createManager(store, { maxRunning: 10 }, undefined, { maxRunning: 2 });

    const launched = [];
    for (let index = 1; index <= 4; index += 1) {
      launched.push(await manager.run({
        mode: "background",
        workspace: "/tmp/project",
        request: `Implement workflow part ${index}`,
        stages: ["implement"],
        routing: {},
        preferredAgent: "claude",
        parentTaskId: "workflow-parent",
        runId: `workflow-child-${index}`
      }));
    }

    assert.deepEqual(
      launched.map(task => manager.get(task.taskId ?? "")?.status),
      ["running", "running", "pending", "pending"]
    );
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

    await waitForStatus(manager, launched.taskId ?? "", "failed");
    const task = manager.get(launched.taskId ?? "");

    assert.equal(task?.status, "failed");
    assert.equal(task?.agentSessionId, "495bcb7d-c68b-4457-9f86-16775d6c97f9");
    assert.match(task?.error ?? "", /role 'system'/);
  });

  it("runs a verification command after successful background work", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-verify-pass-"));
    const verificationTmpDirs: string[] = [];
    const manager = createManager(new TaskStore({ rootDir: storeDir }), undefined, {
      exec: async (command: string, options) => {
        if (options.env?.CODEX_CLAUDE_VERIFY_TMP) verificationTmpDirs.push(options.env.CODEX_CLAUDE_VERIFY_TMP);
        return {
          code: command === "npm test" && Boolean(options.env?.CODEX_CLAUDE_VERIFY_TMP) ? 0 : 1,
          stdout: `tests passed in ${options.env?.CODEX_CLAUDE_VERIFY_TMP ?? ""}`,
          stderr: "",
          timedOut: false
        };
      }
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

    await waitForStatus(manager, launched.taskId ?? "", "completed");
    const task = manager.get(launched.taskId ?? "");

    assert.equal(task?.status, "completed");
    assert.equal(task?.verification?.status, "passed");
    assert.equal(task?.verification?.command, "npm test");
    assert.match(task?.verification?.stdout ?? "", /tests passed in /);
    assert.ok(task?.verification?.tmpDir);
    assert.equal(task?.verification?.tmpDir, verificationTmpDirs[0]);
    assert.equal(task?.resultSummary?.status, "completed");
    assert.equal(task?.resultSummary?.verification?.status, "passed");
    assert.equal(task?.resultSummary?.verification?.tmpDir, verificationTmpDirs[0]);
    assert.match(task?.resultSummary?.summary ?? "", /claude implement/);
  });

  it("summarizes completed task delivery details", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-result-summary-"));
    const coordinator = new AgentCoordinator({
      providers: {
        claude: {
          name: "claude",
          async run(input: StageInput): Promise<StageResult> {
            return {
              ok: true,
              runId: input.runId ?? "result-summary-run",
              stage: input.stage,
              agent: "claude",
              status: "completed",
              agentSessionId: "495bcb7d-c68b-4457-9f86-16775d6c97f9",
              changedFiles: ["src/index.html", "README.md"],
              requiresCodex: false,
              summary: "Created a hello page and updated usage notes."
            };
          }
        }
      }
    });
    const manager = new TaskManager(coordinator, new TaskStore({ rootDir: storeDir }), {
      verification: {
        exec: async () => ({ code: 0, stdout: "ok", stderr: "", timedOut: false })
      }
    });

    const launched = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Create hello page",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "result-summary-run",
      verifyCommand: "npm test"
    });

    await new Promise(resolve => setTimeout(resolve, 40));
    const task = manager.get(launched.taskId ?? "");

    assert.equal(task?.resultSummary?.status, "completed");
    assert.equal(task?.resultSummary?.provider, "claude");
    assert.deepEqual(task?.resultSummary?.providerAttempts, ["claude"]);
    assert.deepEqual(task?.resultSummary?.changedFiles, ["src/index.html", "README.md"]);
    assert.equal(task?.resultSummary?.agentSessions?.[0]?.sessionId, "495bcb7d-c68b-4457-9f86-16775d6c97f9");
    assert.equal(task?.resultSummary?.verification?.status, "passed");
    assert.ok(task?.resultSummary?.nextSteps.some(step => /changed files/i.test(step)));
  });

  it("fails a background task when guardrails detect empty agent output", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-empty-guardrail-store-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-task-empty-guardrail-workspace-"));
    const provider: AgentProvider = {
      name: "claude",
      async run(input) {
        return {
          ok: true,
          runId: input.runId ?? "empty-guardrail-task",
          stage: input.stage,
          agent: "claude",
          status: "completed",
          changedFiles: [],
          requiresCodex: false,
          summary: "   "
        };
      }
    };
    const manager = new TaskManager(new AgentCoordinator({ providers: { claude: provider } }), new TaskStore({ rootDir: storeDir }));

    const launched = await manager.run({
      mode: "background",
      workspace,
      request: "Implement something",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "empty-guardrail-task"
    });
    await waitForStatus(manager, launched.taskId ?? "", "failed");
    const task = manager.get(launched.taskId ?? "");

    assert.match(task?.error ?? "", /Guardrail failed: empty_output/);
    assert.equal(task?.guardrails?.[0]?.kind, "empty_output");
    assert.equal(task?.resultSummary?.guardrails?.[0]?.severity, "error");
  });

  it("continues a completed task when guardrails find unfinished todo items", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-todo-continuation-store-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-task-todo-continuation-workspace-"));
    const requests: string[] = [];
    const provider: AgentProvider = {
      name: "claude",
      async run(input) {
        requests.push(input.request);
        const first = requests.length === 1;
        if (!first) await new Promise(resolve => setTimeout(resolve, 80));
        return {
          ok: true,
          runId: input.runId ?? "todo-continuation-task",
          stage: input.stage,
          agent: "claude",
          status: "completed",
          changedFiles: ["src/app.ts"],
          requiresCodex: false,
          summary: first
            ? "Implemented core pieces.\n- [ ] Wire persistence"
            : "Finished the remaining persistence TODO."
        };
      }
    };
    const manager = new TaskManager(new AgentCoordinator({ providers: { claude: provider } }), new TaskStore({ rootDir: storeDir }));

    const launched = await manager.run({
      mode: "background",
      workspace,
      request: "Implement todo app",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "todo-continuation-task"
    });
    await waitFor(async () => manager.get(launched.taskId ?? "")?.continuationTaskId === "todo-continuation-task-continuation-1");
    assert.equal(manager.get(launched.taskId ?? "")?.status, "running");

    await waitForStatus(manager, launched.taskId ?? "", "completed");
    const source = manager.get(launched.taskId ?? "");
    const continuation = manager.get("todo-continuation-task-continuation-1");

    assert.equal(continuation?.continuationOf, "todo-continuation-task");
    assert.match(requests[1] ?? "", /Continue the task because guardrails found unfinished TODO items/);
    assert.match(requests[1] ?? "", /Wire persistence/);
    assert.equal(source?.continuationTaskId, "todo-continuation-task-continuation-1");
    assert.match(source?.resultSummary?.summary ?? "", /Finished the remaining persistence TODO/);
    assert.equal(source?.resultSummary?.guardrails?.length ?? 0, 0);
  });

  it("records completed tasks into project memory", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-project-memory-store-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-task-project-memory-workspace-"));
    const manager = createManager(new TaskStore({ rootDir: storeDir }), undefined, {
      exec: async () => ({ code: 0, stdout: "ok", stderr: "", timedOut: false })
    });

    const launched = await manager.run({
      mode: "background",
      workspace,
      request: "Remember this implementation",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "project-memory-task",
      verifyCommand: "npm test"
    });

    await waitForStatus(manager, launched.taskId ?? "", "completed");
    await waitForFile(join(workspace, ".codex-claude", "memory", "project-memory.md"));
    const memory = await readFile(join(workspace, ".codex-claude", "memory", "project-memory.md"), "utf8");

    assert.match(memory, /# Project memory/);
    assert.match(memory, /project-memory-task/);
    assert.match(memory, /Remember this implementation/);
    assert.match(memory, /Verification: passed/);
  });

  it("records git checkpoint and diff for completed tasks", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-git-diff-store-"));
    const workspace = await createGitWorkspace("bridge-task-git-diff-workspace-");
    const manager = createFileWritingManager(new TaskStore({ rootDir: storeDir }), "hello from task\n");

    const launched = await manager.run({
      mode: "background",
      workspace,
      request: "Update app text",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "git-diff-task"
    });

    await waitForStatus(manager, launched.taskId ?? "", "completed");
    const task = manager.get(launched.taskId ?? "");

    assert.equal(task?.gitCheckpoint?.supported, true);
    assert.equal(task?.gitCheckpoint?.clean, true);
    assert.match(task?.gitDiff?.patch ?? "", /hello from task/);
    assert.deepEqual(task?.gitDiff?.files.map(file => file.path), ["app.txt"]);
    assert.equal(task?.rollback?.status, "ready");
  });

  it("records file snapshot diff for completed non-git tasks", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-file-snapshot-store-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-task-file-snapshot-workspace-"));
    const manager = createFileWritingManager(new TaskStore({ rootDir: storeDir }), "hello from non-git task\n", []);

    const launched = await manager.run({
      mode: "background",
      workspace,
      request: "Create app text outside git",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "file-snapshot-task"
    });

    await waitForStatus(manager, launched.taskId ?? "", "completed");
    const task = manager.get(launched.taskId ?? "");

    assert.equal(task?.gitCheckpoint?.supported, false);
    assert.equal(task?.gitDiff?.supported, false);
    assert.deepEqual(task?.gitDiff?.files.map(file => `${file.status}:${file.path}`), ["added:app.txt"]);
    assert.deepEqual(task?.resultSummary?.changedFiles, ["app.txt"]);
    assert.equal(task?.rollback?.status, "not_available");
  });

  it("rolls back a completed task when the checkpoint was clean", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-rollback-store-"));
    const workspace = await createGitWorkspace("bridge-task-rollback-workspace-");
    const manager = createFileWritingManager(new TaskStore({ rootDir: storeDir }), "task changed file\n");
    const launched = await manager.run({
      mode: "background",
      workspace,
      request: "Update app text",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "rollback-task"
    });
    await waitForStatus(manager, launched.taskId ?? "", "completed");

    const rolledBack = await manager.rollback(launched.taskId ?? "");

    assert.equal(rolledBack?.rollback?.status, "completed");
    assert.equal(await readFile(join(workspace, "app.txt"), "utf8"), "original\n");
    const status = await execFile("git", ["status", "--short"], { cwd: workspace });
    assert.equal(status.stdout.trim(), "");
  });

  it("does not roll back when the checkpoint started dirty", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-dirty-rollback-store-"));
    const workspace = await createGitWorkspace("bridge-task-dirty-rollback-workspace-");
    await writeFile(join(workspace, "app.txt"), "user dirty change\n", "utf8");
    const manager = createFileWritingManager(new TaskStore({ rootDir: storeDir }), "task changed dirty file\n");
    const launched = await manager.run({
      mode: "background",
      workspace,
      request: "Update app text",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "dirty-rollback-task"
    });
    await waitForStatus(manager, launched.taskId ?? "", "completed");

    const rolledBack = await manager.rollback(launched.taskId ?? "");

    assert.equal(rolledBack?.rollback?.status, "failed");
    assert.match(rolledBack?.rollback?.error ?? "", /dirty/i);
    assert.equal(await readFile(join(workspace, "app.txt"), "utf8"), "task changed dirty file\n");
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

    assert.equal(source?.status, "completed");
    assert.equal(source?.verification?.status, "passed");
    assert.equal(source?.verification?.stderr, "");
    assert.equal(source?.resultSummary?.verification?.repairedBy, "verify-repair-repair-1");
    assert.ok(source?.resultSummary?.nextSteps.some(step => /completed after repair/i.test(step)));
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
    assert.equal(completed?.resultSummary?.kind, "workflow");
    assert.match(completed?.resultSummary?.summary ?? "", /2\/2 child tasks completed/);
  });

  it("does not recreate deleted workspaces when reading completed workflow tasks", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-workflow-deleted-workspace-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-task-workflow-workspace-"));
    await rm(workspace, { recursive: true, force: true });
    const store = new TaskStore({ rootDir: storeDir });
    const now = new Date().toISOString();
    store.save({
      id: "deleted-workspace-child",
      mode: "background",
      status: "completed",
      workspace,
      request: "Implement child",
      stages: ["implement"],
      preferredAgent: "claude",
      runId: "deleted-workspace-child",
      parentTaskId: "deleted-workspace-parent",
      createdAt: now,
      updatedAt: now,
      result: {
        ok: true,
        runId: "deleted-workspace-child",
        summary: "child done",
        results: [{
          ok: true,
          runId: "deleted-workspace-child",
          stage: "implement",
          agent: "claude",
          status: "completed",
          changedFiles: [],
          requiresCodex: false,
          summary: "child done"
        }]
      }
    });
    store.save({
      id: "deleted-workspace-parent",
      kind: "workflow",
      mode: "background",
      status: "completed",
      workspace,
      request: "Implement workflow",
      stages: ["implement"],
      preferredAgent: "claude",
      runId: "deleted-workspace-parent",
      childTaskIds: ["deleted-workspace-child"],
      createdAt: now,
      updatedAt: now
    });

    const manager = createManager(store);
    assert.equal(existsSync(workspace), false);

    const parent = manager.get("deleted-workspace-parent");

    assert.equal(parent?.status, "completed");
    assert.equal(parent?.workflow?.state?.phase, "completed");
    assert.equal(existsSync(workspace), false);
  });

  it("surfaces shared-file risks in workflow summaries", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-workflow-shared-files-"));
    const store = new TaskStore({ rootDir: storeDir });
    const now = new Date().toISOString();
    for (const id of ["workflow-shared-child-a", "workflow-shared-child-b"]) {
      store.save({
        id,
        mode: "background",
        status: "completed",
        workspace: "/tmp/project",
        request: `Implement ${id}`,
        stages: ["implement"],
        preferredAgent: "claude",
        runId: id,
        createdAt: now,
        updatedAt: now,
        result: {
          ok: true,
          runId: id,
          summary: "done",
          results: [{
            ok: true,
            runId: id,
            stage: "implement",
            agent: "claude",
            status: "completed",
            changedFiles: ["src/shared.ts"],
            requiresCodex: false,
            summary: "done"
          }]
        },
        resultSummary: {
          kind: "task",
          status: "completed",
          summary: "done",
          provider: "claude",
          providerAttempts: ["claude"],
          stages: ["implement"],
          changedFiles: ["src/shared.ts"],
          agentSessions: [],
          durationMs: 0,
          nextSteps: []
        }
      });
    }
    store.save({
      id: "workflow-shared-parent",
      kind: "workflow",
      mode: "background",
      status: "running",
      workspace: "/tmp/project",
      request: "Implement workflow",
      stages: [],
      childTaskIds: ["workflow-shared-child-a", "workflow-shared-child-b"],
      runId: "workflow-shared-parent",
      createdAt: now,
      updatedAt: now
    });
    const manager = createManager(store);

    const parent = manager.get("workflow-shared-parent");

    assert.equal(parent?.status, "completed");
    assert.match(parent?.resultSummary?.summary ?? "", /shared files touched/);
    assert.ok(parent?.resultSummary?.nextSteps.some(step => /src\/shared\.ts/.test(step)));
  });

  it("promotes a workflow parent when its repair task passes verification", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-workflow-repair-promote-"));
    let verificationRuns = 0;
    const manager = createManager(new TaskStore({ rootDir: storeDir }), undefined, {
      exec: async () => {
        verificationRuns += 1;
        return verificationRuns === 1
          ? { code: 1, stdout: "", stderr: "workflow verify failed", timedOut: false }
          : { code: 0, stdout: "workflow verify passed after repair", stderr: "", timedOut: false };
      }
    });
    const child = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Implement child",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "workflow-repair-child",
      parentTaskId: "workflow-repair-parent"
    });
    manager.createWorkflowTask({
      id: "workflow-repair-parent",
      workspace: "/tmp/project",
      request: "Implement workflow",
      childTaskIds: [String(child.taskId)],
      verifyCommand: "npm test",
      maxRepairAttempts: 1
    });

    await waitForStatus(manager, "workflow-repair-parent", "completed");
    const parent = manager.get("workflow-repair-parent");
    const repairTaskId = parent?.verification?.repairTaskId;
    const repair = repairTaskId ? manager.get(repairTaskId) : undefined;

    assert.equal(parent?.status, "completed");
    assert.equal(parent?.verification?.status, "passed");
    assert.equal(repairTaskId, "workflow-repair-parent-repair-1");
    assert.equal(repair?.status, "completed");
    assert.equal(repair?.repairOf, "workflow-repair-parent");
    assert.equal(repair?.verification?.status, "passed");
  });

  it("reconciles an already persisted failed workflow when its repair task passed", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "bridge-task-workflow-repair-reconcile-"));
    const store = new TaskStore({ rootDir: storeDir });
    store.save({
      id: "workflow-reconcile-parent",
      kind: "workflow",
      mode: "background",
      status: "failed",
      workspace: "/tmp/project",
      request: "Implement workflow",
      stages: [],
      childTaskIds: [],
      verifyCommand: "npm test",
      verification: {
        command: "npm test",
        status: "failed",
        startedAt: "2026-05-20T00:00:00.000Z",
        finishedAt: "2026-05-20T00:00:01.000Z",
        exitCode: 1,
        stderr: "failed before restart",
        error: "failed before restart",
        repairTaskId: "workflow-reconcile-parent-repair-1"
      },
      runId: "workflow-reconcile-parent",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:01.000Z",
      error: "Verification failed; repair task launched: workflow-reconcile-parent-repair-1"
    });
    store.save({
      id: "workflow-reconcile-parent-repair-1",
      mode: "background",
      status: "completed",
      workspace: "/tmp/project",
      request: "Repair workflow",
      stages: ["implement"],
      repairOf: "workflow-reconcile-parent",
      verifyCommand: "npm test",
      verification: {
        command: "npm test",
        status: "passed",
        startedAt: "2026-05-20T00:00:02.000Z",
        finishedAt: "2026-05-20T00:00:03.000Z",
        exitCode: 0,
        stdout: "passed after restart"
      },
      runId: "workflow-reconcile-parent-repair-1",
      createdAt: "2026-05-20T00:00:02.000Z",
      updatedAt: "2026-05-20T00:00:03.000Z"
    });
    const manager = createManager(store);

    const parent = manager.get("workflow-reconcile-parent");

    assert.equal(parent?.status, "completed");
    assert.equal(parent?.verification?.status, "passed");
    assert.equal(parent?.verification?.repairTaskId, "workflow-reconcile-parent-repair-1");
    assert.equal(parent?.error, undefined);
    assert.equal(store.get("workflow-reconcile-parent")?.status, "completed");
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
  verification?: TaskManagerOptions["verification"],
  workflow?: TaskManagerOptions["workflow"]
): TaskManager {
  const coordinator = new AgentCoordinator({
    providers: {
      claude: new SlowProvider("claude"),
      codex: new SlowProvider("codex")
    }
  });
  return new TaskManager(coordinator, store, { concurrency, verification, workflow });
}

function createFileWritingManager(store: TaskStore, content: string, reportedChangedFiles = ["app.txt"]): TaskManager {
  const coordinator = new AgentCoordinator({
    providers: {
      claude: {
        name: "claude",
        async run(input: StageInput): Promise<StageResult> {
          await writeFile(join(input.workspace, "app.txt"), content, "utf8");
          return {
            ok: true,
            runId: input.runId ?? "file-writing-run",
            stage: input.stage,
            agent: "claude",
            status: "completed",
            changedFiles: reportedChangedFiles,
            requiresCodex: false,
            summary: "Updated app text."
          };
        }
      }
    }
  });
  return new TaskManager(coordinator, store);
}

async function createGitWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  await execFile("git", ["init"], { cwd: workspace });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: workspace });
  await writeFile(join(workspace, "app.txt"), "original\n", "utf8");
  await execFile("git", ["add", "app.txt"], { cwd: workspace });
  await execFile("git", ["commit", "-m", "initial"], { cwd: workspace });
  return workspace;
}

async function waitForStatus(manager: TaskManager, taskId: string, status: DelegatedTask["status"]): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (manager.get(taskId)?.status === status) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${taskId} to become ${status}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for condition");
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  assert.fail(`Timed out waiting for file ${path}`);
}
