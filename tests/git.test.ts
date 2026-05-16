import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChangedFiles } from "../src/utils/git.js";

describe("parseChangedFiles", () => {
  it("preserves dot-prefixed paths from git status --short", () => {
    const files = parseChangedFiles(" M .codex/agents/claude-delegate.toml\n?? src/mcp/tools.ts\n");
    assert.deepEqual(files, [".codex/agents/claude-delegate.toml", "src/mcp/tools.ts"]);
  });
});
