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

  it("routes built-in provider-specific coding profiles", () => {
    const router = new AgentRouter();

    assert.equal(router.resolveRoute("implement", {}, { profile: "codex-coder" }).agent, "codex-cli");
    assert.equal(router.resolveRoute("implement", {}, { profile: "gemini-coder" }).agent, "gemini");
    assert.equal(router.resolveRoute("implement", {}, { profile: "myflicker-coder" }).agent, "myflicker");
  });

  it("routes dedicated agent team profiles with role prompts", () => {
    const router = new AgentRouter();

    const prometheus = router.resolveRoute("plan", {}, { profile: "prometheus" });
    assert.equal(prometheus.agent, "claude");
    assert.match(prometheus.rolePrompt ?? "", /Prometheus/);

    const sisyphus = router.resolveRoute("implement", {}, { profile: "sisyphus" });
    assert.equal(sisyphus.agent, "claude");
    assert.equal(sisyphus.effort, "high");
    assert.match(sisyphus.rolePrompt ?? "", /Sisyphus/);

    const momus = router.resolveRoute("review", {}, { profile: "momus" });
    assert.equal(momus.agent, "claude");
    assert.equal(momus.permission?.mode, "default");
    assert.ok(momus.permission?.disallowedTools?.includes("Write"));
    assert.match(momus.rolePrompt ?? "", /Momus/);
  });
});
