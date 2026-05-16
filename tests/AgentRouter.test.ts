import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentRouter } from "../src/workflow/AgentRouter.js";

describe("AgentRouter", () => {
  it("uses explicit stage agent when provided", () => {
    const router = new AgentRouter();
    assert.equal(router.resolve("plan", { plan: "claude" }), "claude");
  });

  it("uses safe defaults", () => {
    const router = new AgentRouter();
    assert.equal(router.resolve("plan", {}), "codex");
    assert.equal(router.resolve("implement", {}), "claude");
    assert.equal(router.resolve("review", {}), "codex");
  });
});
