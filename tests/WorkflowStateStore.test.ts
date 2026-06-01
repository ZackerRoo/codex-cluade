import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DelegatedTask } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow/WorkflowStateStore.js";

describe("WorkflowStateStore", () => {
  it("creates and advances a persisted workflow state from child tasks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-workflow-state-"));
    await mkdir(join(workspace, ".codex-claude", "plans"), { recursive: true });
    const planPath = join(workspace, ".codex-claude", "plans", "system.md");
    await writeFile(planPath, [
      "# Plan",
      "- [ ] Design auth module",
      "- [ ] Build API layer"
    ].join("\n"), "utf8");
    const store = new WorkflowStateStore(workspace);
    const created = await store.create({
      workflowId: "system-workflow",
      request: "Design a membership system",
      planId: "system",
      planPath,
      childTaskIds: ["system-workflow-part-1", "system-workflow-part-2", "system-workflow-review"],
      reviewTaskId: "system-workflow-review"
    });

    assert.equal(created.phase, "executing");
    assert.equal(created.steps.length, 3);
    assert.equal(created.nextAction.kind, "wait");

    const advanced = await store.updateFromTasks(created.workflowId, [
      task("system-workflow-part-1", "completed", "Design auth done", ["src/auth.ts"]),
      task("system-workflow-part-2", "running", "API in progress"),
      task("system-workflow-review", "pending", "Review")
    ]);

    assert.equal(advanced.phase, "executing");
    assert.equal(advanced.steps[0].status, "completed");
    assert.equal(advanced.steps[1].status, "running");
    assert.equal(advanced.nextAction.kind, "wait");
    assert.ok(advanced.learnings.some(learning => /Design auth done/.test(learning.summary)));

    const reviewed = await store.updateFromTasks(created.workflowId, [
      task("system-workflow-part-1", "completed", "Design auth done", ["src/auth.ts"]),
      task("system-workflow-part-2", "completed", "API layer done", ["src/api.ts"]),
      task("system-workflow-review", "running", "Reviewing")
    ]);

    assert.equal(reviewed.phase, "reviewing");
    assert.equal(reviewed.nextAction.kind, "wait");

    const persisted = JSON.parse(await readFile(created.statePath, "utf8")) as { phase?: string; steps?: unknown[] };
    assert.equal(persisted.phase, "reviewing");
    assert.equal(persisted.steps?.length, 3);
  });
});

function task(id: string, status: DelegatedTask["status"], summary: string, changedFiles: string[] = []): DelegatedTask {
  return {
    id,
    mode: "background",
    status,
    workspace: "/tmp/project",
    request: summary,
    stages: id.includes("review") ? ["review"] : ["implement"],
    runId: id,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:01.000Z",
    result: {
      ok: status === "completed",
      runId: id,
      summary,
      results: [{
        ok: status === "completed",
        runId: id,
        stage: id.includes("review") ? "review" : "implement",
        agent: "claude",
        status: status === "completed" ? "completed" : "failed",
        changedFiles,
        requiresCodex: false,
        summary
      }]
    }
  };
}
