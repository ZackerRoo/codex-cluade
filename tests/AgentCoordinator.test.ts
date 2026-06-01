import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentProvider } from "../src/agents/AgentProvider.js";
import { AgentCoordinator } from "../src/workflow/AgentCoordinator.js";
import type { AgentName, StageInput, StageResult } from "../src/types.js";

class FakeProvider implements AgentProvider {
  inputs: StageInput[] = [];

  constructor(readonly name: AgentName, private readonly ok = true) {}

  async run(input: StageInput): Promise<StageResult> {
    this.inputs.push(input);
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

  it("falls back across provider CLIs before handing back to Codex", async () => {
    const coordinator = new AgentCoordinator({
      providers: {
        claude: new FakeProvider("claude", false),
        "codex-cli": new FakeProvider("codex-cli", false),
        gemini: new FakeProvider("gemini"),
        codex: new FakeProvider("codex")
      }
    });

    const result = await coordinator.run({
      workspace: "/tmp/project",
      request: "Implement login cache",
      stages: ["implement"],
      routing: {},
      profile: "multi-coder",
      runId: "multi-provider-fallback"
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map(item => item.agent), ["claude", "codex-cli", "gemini"]);
  });

  it("passes dedicated profile role prompts into stage inputs", async () => {
    const claude = new FakeProvider("claude");
    const coordinator = new AgentCoordinator({
      providers: {
        claude
      }
    });

    const result = await coordinator.run({
      workspace: "/tmp/project",
      request: "Plan login cache",
      stages: [],
      routing: {},
      profile: "prometheus",
      runId: "prometheus-run"
    });

    assert.equal(result.ok, true);
    assert.equal(claude.inputs[0].stage, "plan");
    assert.match(claude.inputs[0].rolePrompt ?? "", /Prometheus/);
  });

  it("injects workspace context into stage inputs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-coordinator-context-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Coordinator Context\n", "utf8");
    await writeFile(join(workspace, "src", "service.ts"), "export class UserService {}\n", "utf8");
    const claude = new FakeProvider("claude");
    const coordinator = new AgentCoordinator({
      providers: {
        claude
      }
    });

    const result = await coordinator.run({
      workspace,
      request: "Summarize project",
      stages: ["analyze"],
      routing: { analyze: "claude" },
      runId: "context-run"
    });

    assert.equal(result.ok, true);
    assert.match(claude.inputs[0].workspaceContext ?? "", /Coordinator Context/);
    assert.match(claude.inputs[0].workspaceContext ?? "", /UserService/);
  });
});
