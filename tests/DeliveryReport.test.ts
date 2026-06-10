import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDeliveryReport } from "../src/workflow/DeliveryReport.js";
import type { DelegatedTask } from "../src/types.js";

describe("buildDeliveryReport", () => {
  it("summarizes repaired delivery status, providers, files, and verification", () => {
    const task: DelegatedTask = {
      id: "delivery-task",
      mode: "background",
      status: "completed",
      workspace: "/tmp/project",
      request: "Build a hello page",
      stages: ["implement"],
      preferredAgent: "claude",
      runId: "delivery-task",
      verifyCommand: "npm test",
      verification: {
        command: "npm test",
        status: "passed",
        startedAt: "2026-06-04T00:00:00.000Z",
        finishedAt: "2026-06-04T00:00:02.000Z",
        tmpDir: "/tmp/codex-claude-verify-delivery-task-abc",
        exitCode: 0,
        repairTaskId: "delivery-task-repair-1"
      },
      resultSummary: {
        kind: "task",
        status: "completed",
        summary: "Created index.html and verified it.",
        provider: "claude",
        providerAttempts: ["claude", "codex-cli"],
        stages: ["implement"],
        changedFiles: ["index.html", "README.md"],
        agentSessions: [],
        verification: {
          command: "npm test",
          status: "passed",
          exitCode: 0,
          tmpDir: "/tmp/codex-claude-verify-delivery-task-abc",
          repairedBy: "delivery-task-repair-1"
        },
        durationMs: 2000,
        nextSteps: ["Open index.html in a browser."]
      },
      gitDiff: {
        supported: true,
        files: [{ path: "index.html", status: "modified" }],
        generatedAt: "2026-06-04T00:00:02.000Z"
      },
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:02.000Z"
    };

    const report = buildDeliveryReport(task);

    assert.equal(report.statusLabel, "completed after repair");
    assert.match(report.markdown, /# Delivery report/);
    assert.match(report.markdown, /completed after repair/);
    assert.match(report.markdown, /claude -> codex-cli/);
    assert.match(report.markdown, /index\.html/);
    assert.match(report.markdown, /npm test/);
    assert.match(report.markdown, /delivery-task-repair-1/);
    assert.match(report.markdown, /CODEX_CLAUDE_VERIFY_TMP/);
  });

  it("summarizes workflow plan-unit completion from related child tasks", () => {
    const parent: DelegatedTask = {
      id: "workflow-delivery",
      kind: "workflow",
      mode: "background",
      status: "completed",
      workspace: "/tmp/project",
      request: "Build a small app",
      stages: [],
      runId: "workflow-delivery",
      childTaskIds: ["workflow-delivery-part-1", "workflow-delivery-review"],
      reviewTaskId: "workflow-delivery-review",
      workflow: {
        kind: "ultrawork",
        summary: { total: 2, completed: 2, failed: 0, running: 0, pending: 0 }
      },
      resultSummary: {
        kind: "workflow",
        status: "completed",
        summary: "2/2 child tasks completed; verification passed",
        providerAttempts: ["claude"],
        stages: [],
        changedFiles: ["src/app.ts"],
        agentSessions: [],
        durationMs: 1000,
        nextSteps: []
      },
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:01.000Z"
    };
    const child: DelegatedTask = {
      id: "workflow-delivery-part-1",
      mode: "background",
      status: "completed",
      workspace: "/tmp/project",
      request: "Implement app shell",
      stages: ["implement"],
      profile: "multi-coder",
      runId: "workflow-delivery-part-1",
      resultSummary: {
        kind: "task",
        status: "completed",
        summary: "Implemented app shell.",
        provider: "claude",
        providerAttempts: ["claude"],
        stages: ["implement"],
        changedFiles: ["src/app.ts"],
        agentSessions: [],
        durationMs: 1000,
        nextSteps: []
      },
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:01.000Z"
    };
    const review: DelegatedTask = {
      id: "workflow-delivery-review",
      mode: "background",
      status: "completed",
      workspace: "/tmp/project",
      request: "Review implementation",
      stages: ["review"],
      profile: "momus",
      runId: "workflow-delivery-review",
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:01.000Z"
    };

    const report = buildDeliveryReport(parent, [child, review]);

    assert.match(report.markdown, /Plan units/);
    assert.match(report.markdown, /2\/2 completed/);
    assert.match(report.markdown, /workflow-delivery-part-1: completed/);
    assert.match(report.markdown, /workflow-delivery-review: completed/);
  });
});
