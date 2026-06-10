import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProjectMemoryStore } from "../src/workflow/ProjectMemory.js";
import type { DelegatedTask } from "../src/types.js";

describe("ProjectMemoryStore", () => {
  it("records terminal task delivery memory as json and markdown", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-project-memory-"));
    const store = new ProjectMemoryStore(workspace);
    const task = createCompletedTask(workspace);

    const memory = await store.recordTask(task);

    assert.equal(memory.entries.length, 1);
    assert.equal(memory.entries[0].taskId, "memory-task");
    assert.deepEqual(memory.entries[0].changedFiles, ["src/app.ts"]);
    assert.equal(memory.entries[0].verificationStatus, "passed");
    assert.deepEqual(memory.entries[0].providerAttempts, ["claude", "codex-cli"]);

    const markdown = await readFile(store.markdownPath, "utf8");
    assert.match(markdown, /# Project memory/);
    assert.match(markdown, /memory-task/);
    assert.match(markdown, /Build app shell/);
    assert.match(markdown, /src\/app\.ts/);
    assert.match(markdown, /claude -> codex-cli/);
    assert.match(markdown, /Verification: passed/);

    await stat(store.jsonPath);
  });

  it("keeps the latest entry per task id", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-project-memory-dedupe-"));
    const store = new ProjectMemoryStore(workspace);
    await store.recordTask(createCompletedTask(workspace, "First summary"));

    const memory = await store.recordTask(createCompletedTask(workspace, "Updated summary"));

    assert.equal(memory.entries.length, 1);
    assert.equal(memory.entries[0].summary, "Updated summary");
  });
});

function createCompletedTask(workspace: string, summary = "Implemented app shell."): DelegatedTask {
  return {
    id: "memory-task",
    mode: "background",
    status: "completed",
    workspace,
    request: "Build app shell",
    stages: ["implement"],
    profile: "coder",
    preferredAgent: "claude",
    runId: "memory-task",
    verification: {
      command: "npm test",
      status: "passed",
      startedAt: "2026-06-04T00:00:00.000Z",
      finishedAt: "2026-06-04T00:00:01.000Z",
      exitCode: 0
    },
    resultSummary: {
      kind: "task",
      status: "completed",
      summary,
      provider: "claude",
      providerAttempts: ["claude", "codex-cli"],
      stages: ["implement"],
      changedFiles: ["src/app.ts"],
      agentSessions: [],
      verification: {
        command: "npm test",
        status: "passed",
        exitCode: 0
      },
      durationMs: 1000,
      nextSteps: ["Review changed files."]
    },
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:01.000Z"
  };
}
