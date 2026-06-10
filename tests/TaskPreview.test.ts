import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTaskPreview } from "../src/workflow/TaskPreview.js";

describe("buildTaskPreview", () => {
  it("previews ultrawork as a multi-agent workflow with verification warning", () => {
    const preview = buildTaskPreview({
      workspace: "/tmp/project",
      request: "实现一个复杂的网页游戏",
      command: "/ultrawork",
      providerChecks: [{ provider: "claude", status: "ready" }],
      workspaceExists: true,
      git: { supported: true, clean: true }
    });

    assert.equal(preview.strategy, "ultrawork");
    assert.equal(preview.risk.level, "medium");
    assert.ok(preview.executionPlan.some(step => /planner/i.test(step.role)));
    assert.ok(preview.executionPlan.some(step => /review/i.test(step.stage)));
    assert.ok(preview.warnings.some(warning => /verify command/i.test(warning.message)));
    assert.equal(preview.recommendedSetup?.command, "/ultrawork");
    assert.equal(preview.recommendedSetup?.mode, "background");
  });

  it("flags dirty workspaces and missing selected providers", () => {
    const preview = buildTaskPreview({
      workspace: "/tmp/project",
      request: "修复登录缓存",
      command: "/start-work",
      preferredAgent: "gemini",
      verifyCommand: "npm test",
      providerChecks: [{ provider: "gemini", status: "missing", error: "spawn gemini ENOENT" }],
      workspaceExists: true,
      git: { supported: true, clean: false, status: [" M src/app.ts"] }
    });

    assert.equal(preview.strategy, "direct");
    assert.equal(preview.risk.level, "high");
    assert.ok(preview.warnings.some(warning => warning.code === "provider_unavailable"));
    assert.ok(preview.warnings.some(warning => warning.code === "dirty_workspace"));
    assert.match(preview.recommendedAction, /fix provider/i);
    assert.equal(preview.recommendedSetup?.preferredAgent, "");
    assert.equal(preview.recommendedSetup?.requiresConfirmation, true);
  });

  it("uses auto plan strategy for complex requests", () => {
    const preview = buildTaskPreview({
      workspace: "/tmp/project",
      request: "先设计一个复杂的 KV 数据库架构，然后实现",
      command: "/start-work",
      strategy: "auto",
      providerChecks: [{ provider: "claude", status: "ready" }],
      workspaceExists: true,
      git: { supported: false, clean: false }
    });

    assert.equal(preview.strategy, "plan");
    assert.equal(preview.executionPlan[0]?.stage, "plan");
    assert.ok(preview.warnings.some(warning => warning.code === "not_git"));
    assert.equal(preview.recommendedSetup?.command, "/ultrawork");
  });
});
