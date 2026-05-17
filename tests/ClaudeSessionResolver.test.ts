import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveClaudeSessionInfo } from "../src/agents/ClaudeSessionResolver.js";

describe("resolveClaudeSessionInfo", () => {
  it("uses Claude JSON stdout session id when present", async () => {
    const workspace = "/tmp/bridge-session-json";
    const sessionId = "57a91bf5-6a80-43c7-93d0-4095a19b4302";
    const transcriptDir = join(homedir(), ".claude", "projects", "-tmp-bridge-session-json");
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, "", "utf8");

    const result = await resolveClaudeSessionInfo({
      workspace,
      stdout: JSON.stringify({ session_id: sessionId, result: "done" }),
      startedAt: new Date(),
      claudePath: "claude"
    });

    assert.equal(result?.sessionId, sessionId);
    assert.equal(result?.transcriptPath, transcriptPath);
    assert.equal(result?.resumeCommand, `cd '${workspace}' && 'claude' --resume ${sessionId}`);
  });

  it("falls back to the newest transcript for the workspace", async () => {
    const workspace = "/tmp/bridge-session-recent";
    const sessionId = "93db26ea-db08-4ad3-ac22-09861a54edfa";
    const transcriptDir = join(homedir(), ".claude", "projects", "-tmp-bridge-session-recent");
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
    const startedAt = new Date();
    await writeFile(transcriptPath, JSON.stringify({ sessionId }), "utf8");

    const result = await resolveClaudeSessionInfo({
      workspace,
      stdout: JSON.stringify({ result: "done" }),
      startedAt,
      claudePath: "/usr/local/bin/claude"
    });

    assert.equal(result?.sessionId, sessionId);
    assert.equal(result?.transcriptPath, transcriptPath);
    assert.equal(result?.resumeCommand, `cd '${workspace}' && '/usr/local/bin/claude' --resume ${sessionId}`);
  });
});
