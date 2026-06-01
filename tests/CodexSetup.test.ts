import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildCodexMcpConfig, setupCodexMcpConfig } from "../src/config/CodexSetup.js";

describe("Codex setup", () => {
  it("builds a Codex MCP config snippet for the unified dashboard runtime", () => {
    const snippet = buildCodexMcpConfig({
      serverPath: "/repo/dist/src/mcpDashboardServer.js",
      port: 8787,
      claudePath: "/bin/claude",
      codexPath: "/bin/codex",
      geminiPath: "/bin/gemini",
      opencodePath: "/bin/opencode"
    });

    assert.match(snippet, /\[mcp_servers\.claude-agent-bridge\]/);
    assert.match(snippet, /command = "node"/);
    assert.match(snippet, /args = \["\/repo\/dist\/src\/mcpDashboardServer\.js", "--port", "8787"\]/);
    assert.match(snippet, /CLAUDE_CODE_PATH = "\/bin\/claude"/);
    assert.match(snippet, /OPENCODE_CLI_PATH = "\/bin\/opencode"/);
  });

  it("dry-runs without writing the Codex config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-codex-setup-dry-"));
    const configPath = join(dir, "config.toml");

    const result = await setupCodexMcpConfig({
      configPath,
      serverPath: "/repo/dist/src/mcpDashboardServer.js",
      write: false
    });

    assert.equal(result.written, false);
    assert.equal(result.configPath, configPath);
    assert.match(result.content, /claude-agent-bridge/);
    await assert.rejects(readFile(configPath, "utf8"));
  });

  it("writes or replaces only the bridge MCP block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-codex-setup-write-"));
    const configPath = join(dir, "config.toml");
    const first = await setupCodexMcpConfig({
      configPath,
      serverPath: "/old/server.js",
      port: 8787,
      write: true
    });
    assert.equal(first.written, true);

    const second = await setupCodexMcpConfig({
      configPath,
      serverPath: "/new/server.js",
      port: 9999,
      write: true,
      existingContent: [
        "[agents]",
        "max_threads = 6",
        "",
        await readFile(configPath, "utf8"),
        "",
        "[mcp_servers.other]",
        "command = \"node\""
      ].join("\n")
    });

    assert.equal(second.written, true);
    const content = await readFile(configPath, "utf8");
    assert.match(content, /\[agents\]\nmax_threads = 6/);
    assert.match(content, /\[mcp_servers\.other\]/);
    assert.match(content, /\/new\/server\.js/);
    assert.match(content, /"--port", "9999"/);
    assert.doesNotMatch(content, /\/old\/server\.js/);
  });
});
