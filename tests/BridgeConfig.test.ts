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
      defaults: { timeoutMs: 123 },
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
    assert.equal(config.defaults?.timeoutMs, 123);
    assert.equal(config.profiles?.coder2?.agent, "claude");
  });
});
