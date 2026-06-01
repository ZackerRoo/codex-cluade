import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStagePrompt } from "../src/prompts/stagePrompts.js";

describe("buildStagePrompt", () => {
  it("asks planning stages not to edit files", () => {
    const prompt = buildStagePrompt({
      stage: "plan",
      agent: "claude",
      workspace: "/tmp/project",
      request: "Add login cache",
      previousOutputs: {}
    });

    assert.match(prompt, /Stage: plan/);
    assert.match(prompt, /Do not edit files/);
    assert.match(prompt, /Add login cache/);
  });

  it("includes previous outputs for implementation", () => {
    const prompt = buildStagePrompt({
      stage: "implement",
      agent: "claude",
      workspace: "/tmp/project",
      request: "Add login cache",
      previousOutputs: { plan: "Change session.ts" }
    });

    assert.match(prompt, /Stage: implement/);
    assert.match(prompt, /Change session\.ts/);
    assert.match(prompt, /Do not commit/);
  });

  it("includes dedicated agent role prompts", () => {
    const prompt = buildStagePrompt({
      stage: "review",
      agent: "codex",
      workspace: "/tmp/project",
      request: "Review changes",
      rolePrompt: "You are Momus. Be strict.",
      previousOutputs: {}
    });

    assert.match(prompt, /## Agent role/);
    assert.match(prompt, /You are Momus/);
  });

  it("injects workspace context and code intelligence guidance", () => {
    const prompt = buildStagePrompt({
      stage: "analyze",
      agent: "claude",
      workspace: "/tmp/project",
      request: "Summarize the project",
      workspaceContext: "Languages: typescript\nSymbols: UserService, formatUser",
      previousOutputs: {}
    });

    assert.match(prompt, /## Workspace context/);
    assert.match(prompt, /Languages: typescript/);
    assert.match(prompt, /code_symbols/);
    assert.match(prompt, /code_definition/);
    assert.match(prompt, /code_references/);
    assert.match(prompt, /code_diagnostics/);
  });
});
