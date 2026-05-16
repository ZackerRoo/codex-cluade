import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runClaudeStageTool } from "../src/mcp/tools.js";

describe("runClaudeStageTool", () => {
  it("returns structured content and text for successful Claude stages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-mcp-test-"));
    const result = await runClaudeStageTool(
      {
        stage: "plan",
        workspace,
        request: "Plan login cache",
        runId: "test-run"
      },
      {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "plan output" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.agent, "claude");
    assert.equal(result.content[0].type, "text");
    if (result.content[0].type === "text") {
      assert.match(result.content[0].text, /Claude plan completed/);
    }
  });

  it("returns tool errors as visible MCP results", async () => {
    const result = await runClaudeStageTool(
      {
        stage: "plan",
        workspace: "",
        request: "Plan login cache"
      },
      {
        claudePath: "claude"
      }
    );

    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, "text");
    if (result.content[0].type === "text") {
      assert.match(result.content[0].text, /workspace is required/);
    }
  });
});
