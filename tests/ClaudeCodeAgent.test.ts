import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ClaudeCodeAgent } from "../src/agents/ClaudeCodeAgent.js";

describe("ClaudeCodeAgent", () => {
  it("runs claude plan stage without Claude Code plan approval mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const calls: string[][] = [];
    const inputs: Array<string | undefined> = [];
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async (_command: string, args: string[], options) => {
        calls.push(args);
        inputs.push(options.input);
        return {
          code: 0,
          stdout: JSON.stringify({ result: "plan output" }),
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => []
    });

    const result = await agent.run({
      stage: "plan",
      agent: "claude",
      workspace,
      request: "Add login cache",
      runId: "2026-05-16-001"
    });

    assert.equal(result.ok, true);
    assert.match(result.summary, /completed/);
    assert.ok(result.outputPath);
    assert.equal(await readFile(result.outputPath, "utf8"), "plan output");
    assert.ok(calls[0].includes("-p"));
    assert.ok(calls[0].includes("--output-format"));
    assert.ok(calls[0].includes("json"));
    assert.ok(calls[0].includes("--permission-mode"));
    assert.ok(calls[0].includes("default"));
    assert.ok(!calls[0].includes("plan"));
    const disallowedIndex = calls[0].indexOf("--disallowedTools");
    assert.notEqual(disallowedIndex, -1);
    assert.equal(calls[0][disallowedIndex + 1], "Edit,MultiEdit,Write,NotebookEdit");
    assert.doesNotMatch(calls[0].at(-1) ?? "", /Stage: plan/);
    assert.match(inputs[0] ?? "", /Stage: plan/);
  });

  it("runs claude implement stage with edit permissions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const calls: string[][] = [];
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ result: "implemented" }),
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => ["src/example.ts"]
    });

    const result = await agent.run({
      stage: "implement",
      agent: "claude",
      workspace,
      request: "Add login cache",
      runId: "2026-05-16-002"
    });

    assert.equal(result.ok, true);
    assert.equal(result.changedFiles[0], "src/example.ts");
    assert.ok(calls[0].includes("--permission-mode"));
    assert.ok(calls[0].includes("acceptEdits"));
    assert.ok(!calls[0].includes("--disallowedTools"));
  });
});
