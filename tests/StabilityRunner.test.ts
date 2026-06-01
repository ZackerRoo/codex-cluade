import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentProvider } from "../src/agents/AgentProvider.js";
import type { AgentName, StageInput, StageResult } from "../src/types.js";
import { StabilityRunner, StabilityRunStore } from "../src/stability/StabilityRunner.js";
import { AgentCoordinator } from "../src/workflow/AgentCoordinator.js";
import { TaskManager } from "../src/workflow/TaskManager.js";
import { TaskStore } from "../src/workflow/TaskStore.js";

class StabilityProvider implements AgentProvider {
  constructor(private readonly agentName: AgentName, private readonly fail = false) {}

  get name(): AgentName {
    return this.agentName;
  }

  async run(input: StageInput): Promise<StageResult> {
    await new Promise(resolve => setTimeout(resolve, 5));
    return {
      ok: !this.fail,
      runId: input.runId ?? "stability-run",
      stage: input.stage,
      agent: this.agentName,
      status: this.fail ? "failed" : "completed",
      changedFiles: [],
      requiresCodex: false,
      summary: this.fail ? `${this.agentName} failed` : `${this.agentName} completed`,
      error: this.fail ? "provider failed" : undefined
    };
  }
}

describe("StabilityRunner", () => {
  it("launches provider matrix tasks and summarizes persisted results", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bridge-stability-store-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "bridge-stability-workspaces-"));
    const taskStore = new TaskStore({ rootDir: join(rootDir, "tasks") });
    const manager = new TaskManager(
      new AgentCoordinator({
        providers: {
          claude: new StabilityProvider("claude"),
          "codex-cli": new StabilityProvider("codex-cli", true)
        }
      }),
      taskStore,
      { concurrency: { maxRunning: 2 } }
    );
    const store = new StabilityRunStore({ rootDir: join(rootDir, "stability") });
    const runner = new StabilityRunner({ taskManager: manager, store });

    const run = await runner.start({
      request: "Create a tiny status file.",
      workspaceRoot,
      providers: ["claude", "codex-cli"],
      iterations: 2,
      verifyCommand: `${process.execPath} -e "process.exit(0)"`
    });

    assert.equal(run.tasks.length, 4);
    assert.ok(run.tasks.every((task: { workspace: string }) => task.workspace.startsWith(workspaceRoot)));

    await waitFor(async () => {
      const refreshed = await runner.refresh(run.id);
      return refreshed?.status === "completed";
    });

    const report = await runner.refresh(run.id);
    assert.equal(report?.summary.total, 4);
    assert.equal(report?.summary.completed, 2);
    assert.equal(report?.summary.failed, 2);
    assert.equal(report?.summary.byProvider.claude.completed, 2);
    assert.equal(report?.summary.byProvider["codex-cli"].failed, 2);
    assert.equal(report?.summary.byProvider.claude.successRate, 1);
    assert.equal(report?.summary.byProvider["codex-cli"].successRate, 0);

    const restored = new StabilityRunStore({ rootDir: join(rootDir, "stability") }).get(run.id);
    assert.equal(restored?.summary.total, 4);
    assert.equal(restored?.tasks[0]?.taskId.includes(run.id), true);
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for condition");
}
