import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProvider } from "../src/agents/AgentProvider.js";
import { AgentCoordinator } from "../src/workflow/AgentCoordinator.js";
import type { AgentName, StageInput, StageResult } from "../src/types.js";

class FakeProvider implements AgentProvider {
  constructor(readonly name: AgentName, private readonly ok = true) {}

  async run(input: StageInput): Promise<StageResult> {
    return {
      ok: this.ok,
      runId: input.runId ?? "test-run",
      stage: input.stage,
      agent: this.name,
      status: this.ok ? "completed" : "failed",
      changedFiles: [],
      requiresCodex: false,
      summary: `${this.name} ${input.stage}`
    };
  }
}

describe("AgentCoordinator", () => {
  it("runs stages in order and carries previous outputs", async () => {
    const coordinator = new AgentCoordinator({
      providers: {
        claude: new FakeProvider("claude"),
        codex: new FakeProvider("codex")
      }
    });

    const result = await coordinator.run({
      workspace: "/tmp/project",
      request: "Add login cache",
      stages: ["plan", "implement"],
      routing: { plan: "claude", implement: "claude" },
      runId: "test-run"
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].stage, "plan");
    assert.equal(result.results[1].stage, "implement");
  });

  it("falls back to the next candidate when category routing fails", async () => {
    const coordinator = new AgentCoordinator({
      providers: {
        claude: new FakeProvider("claude", false),
        codex: new FakeProvider("codex")
      }
    });

    const result = await coordinator.run({
      workspace: "/tmp/project",
      request: "Implement login cache",
      stages: ["implement"],
      routing: {},
      category: "coding",
      runId: "fallback-run"
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].agent, "claude");
    assert.equal(result.results[0].ok, false);
    assert.equal(result.results[1].agent, "codex");
    assert.equal(result.results[1].ok, true);
  });
});
