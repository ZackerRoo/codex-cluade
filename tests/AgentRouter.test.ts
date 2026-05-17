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

  it("uses preferred agent before category and defaults", () => {
    const router = new AgentRouter();
    assert.equal(router.resolve("review", {}, { preferredAgent: "claude", category: "review" }), "claude");
  });

  it("routes common categories to default agents", () => {
    const router = new AgentRouter();
    assert.equal(router.resolve("plan", {}, { category: "coding" }), "claude");
    assert.equal(router.resolve("implement", {}, { category: "fast" }), "codex");
    assert.equal(router.resolve("analyze", {}, { category: "heavy" }), "claude");
    assert.equal(router.resolve("implement", {}, { category: "review" }), "codex");
  });

  it("routes named profiles with execution defaults", () => {
    const router = new AgentRouter();
    const route = router.resolveRoute("implement", {}, { profile: "heavy-coder" });

    assert.equal(route.agent, "claude");
    assert.equal(route.category, "heavy");
    assert.equal(route.effort, "high");
    assert.equal(route.timeoutMs, 900_000);
  });
});
