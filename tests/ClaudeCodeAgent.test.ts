import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ClaudeCodeAgent } from "../src/agents/ClaudeCodeAgent.js";

describe("ClaudeCodeAgent", () => {
  it("runs claude with print json mode and stores output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const calls: string[][] = [];
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
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
    assert.ok(calls[0].includes("plan"));
  });
});
