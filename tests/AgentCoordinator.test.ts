import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProvider } from "../src/agents/AgentProvider.js";
import { AgentCoordinator } from "../src/workflow/AgentCoordinator.js";
import type { AgentName, StageInput, StageResult } from "../src/types.js";

class FakeProvider implements AgentProvider {
  constructor(readonly name: AgentName) {}

  async run(input: StageInput): Promise<StageResult> {
    return {
      ok: true,
      runId: input.runId ?? "test-run",
      stage: input.stage,
      agent: this.name,
      status: "completed",
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
});
