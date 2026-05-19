import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../src/agents/AgentProvider.js";
import { AgentCoordinator } from "../src/workflow/AgentCoordinator.js";
import { TaskManager } from "../src/workflow/TaskManager.js";
import { TaskStore } from "../src/workflow/TaskStore.js";
import type { AgentName, StageInput, StageResult } from "../src/types.js";

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
});

function createManager(store?: TaskStore, concurrency?: { maxRunning?: number }): TaskManager {
  const coordinator = new AgentCoordinator({
    providers: {
      claude: new SlowProvider("claude"),
      codex: new SlowProvider("codex")
    }
  });
  return new TaskManager(coordinator, store, { concurrency });
}
