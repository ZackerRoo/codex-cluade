import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DelegatedTask } from "../src/types.js";
import { buildTaskResultSummary } from "../src/workflow/TaskResultSummary.js";

describe("buildTaskResultSummary", () => {
  it("scores verified completed tasks as successful", () => {
    const summary = buildTaskResultSummary(task({
      status: "completed",
      verification: {
        command: "npm test",
        status: "passed",
        startedAt: "2026-06-08T00:00:00.000Z",
        finishedAt: "2026-06-08T00:00:01.000Z",
        exitCode: 0
      }
    }));

    assert.equal(summary.quality!.status, "success");
    assert.equal(summary.failure, undefined);
    assert.ok(summary.quality!.reasons.some(reason => /verification passed/i.test(reason)));
  });

  it("marks completed tasks without verification as partial when files changed", () => {
    const summary = buildTaskResultSummary(task({
      status: "completed",
      result: {
        results: [{
          ok: true,
          runId: "quality-task",
          stage: "implement",
          agent: "claude",
          status: "completed",
          changedFiles: ["src/app.ts"],
          requiresCodex: false,
          summary: "Implemented app."
        }]
      }
    }));

    assert.equal(summary.quality!.status, "partial");
    assert.ok(summary.quality!.reasons.some(reason => /no verification/i.test(reason)));
  });

  it("classifies failed verification as verification failure", () => {
    const summary = buildTaskResultSummary(task({
      status: "failed",
      error: "Verification failed: test failed",
      verification: {
        command: "npm test",
        status: "failed",
        startedAt: "2026-06-08T00:00:00.000Z",
        finishedAt: "2026-06-08T00:00:01.000Z",
        exitCode: 1,
        error: "Command failed with exit code 1"
      }
    }));

    assert.equal(summary.quality!.status, "failed");
    assert.equal(summary.failure?.category, "verification_failed");
    assert.match(summary.failure?.nextAction ?? "", /repair/i);
  });

  it("classifies missing provider executables as environment failures", () => {
    const summary = buildTaskResultSummary(task({
      status: "failed",
      error: "spawn claude ENOENT"
    }));

    assert.equal(summary.quality!.status, "failed");
    assert.equal(summary.failure?.category, "environment");
    assert.match(summary.failure?.nextAction ?? "", /install/i);
  });

  it("classifies guardrail empty output as empty output failure", () => {
    const summary = buildTaskResultSummary(task({
      status: "failed",
      guardrails: [{
        kind: "empty_output",
        severity: "error",
        message: "Agent returned no useful output."
      }]
    }));

    assert.equal(summary.quality!.status, "failed");
    assert.equal(summary.failure?.category, "empty_output");
  });
});

function task(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: "quality-task",
    mode: "background",
    status: "completed",
    workspace: "/tmp/project",
    request: "Implement app",
    stages: ["implement"],
    preferredAgent: "claude",
    runId: "quality-task",
    result: {
      results: [{
        ok: true,
        runId: "quality-task",
        stage: "implement",
        agent: "claude",
        status: "completed",
        changedFiles: [],
        requiresCodex: false,
        summary: "Task completed."
      }]
    },
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:01.000Z",
    ...overrides
  };
}
