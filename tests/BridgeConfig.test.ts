import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadBridgeConfig } from "../src/config/BridgeConfig.js";

describe("loadBridgeConfig", () => {
  it("loads config from CODEX_CLAUDE_CONFIG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));
    const path = join(dir, "config.json");
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify({
      claudePath: "/tmp/claude",
      codexPath: "/tmp/codex",
      geminiPath: "/tmp/gemini",
      opencodePath: "/tmp/opencode",
      myflickerPath: "/tmp/m",
      defaults: { timeoutMs: 123, claudeModel: "pa/claude-opus-4-7" },
      concurrency: { maxRunning: 2 },
      workflow: { maxRunning: 3, maxImplementationTasks: 6 },
      profiles: {
        coder2: {
          description: "Custom coder",
          category: "coding",
          agent: "claude",
          stages: ["implement"]
        }
      }
    }), "utf8");

    const config = loadBridgeConfig(dir, { CODEX_CLAUDE_CONFIG: path });
    assert.equal(config.claudePath, "/tmp/claude");
    assert.equal(config.codexPath, "/tmp/codex");
    assert.equal(config.geminiPath, "/tmp/gemini");
    assert.equal(config.opencodePath, "/tmp/opencode");
    assert.equal(config.myflickerPath, "/tmp/m");
    assert.equal(config.defaults?.timeoutMs, 123);
    assert.equal(config.defaults?.claudeModel, "pa/claude-opus-4-7");
    assert.equal(config.concurrency?.maxRunning, 2);
    assert.equal(config.workflow?.maxRunning, 3);
    assert.equal(config.workflow?.maxImplementationTasks, 6);
    assert.equal(config.profiles?.coder2?.agent, "claude");
  });
});
