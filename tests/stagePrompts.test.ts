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
});
