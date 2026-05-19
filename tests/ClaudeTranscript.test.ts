import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaudeTranscript } from "../src/agents/ClaudeTranscript.js";

describe("parseClaudeTranscript", () => {
  it("extracts session metadata, tool calls, file writes, and usage", () => {
    const transcript = [
      JSON.stringify({
        type: "user",
        sessionId: "57a91bf5-6a80-43c7-93d0-4095a19b4302",
        cwd: "/tmp/project",
        permissionMode: "bypassPermissions",
        timestamp: "2026-05-19T10:00:00.000Z"
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-19T10:00:01.000Z",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Write",
              input: { file_path: "/tmp/project/index.html", content: "<html></html>" }
            }
          ]
        }
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-19T10:00:02.000Z",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }
          ]
        }
      })
    ].join("\n");

    const summary = parseClaudeTranscript(transcript);

    assert.equal(summary.sessionId, "57a91bf5-6a80-43c7-93d0-4095a19b4302");
    assert.equal(summary.cwd, "/tmp/project");
    assert.equal(summary.models[0], "claude-opus-4-7");
    assert.equal(summary.toolCalls[0].name, "Write");
    assert.equal(summary.fileWrites[0], "/tmp/project/index.html");
    assert.equal(summary.usage.inputTokens, 10);
    assert.equal(summary.usage.outputTokens, 20);
    assert.equal(summary.timeline.length, 3);
  });
});
