import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runInstallDoctor } from "../src/install/InstallDoctor.js";

describe("runInstallDoctor", () => {
  it("reports a ready install when Codex config and providers are available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-install-doctor-ready-"));
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, [
      "[mcp_servers.claude-agent-bridge]",
      "command = \"node\"",
      "args = [\"/repo/dist/src/mcpDashboardServer.js\", \"--port\", \"8787\"]",
      "",
      "[mcp_servers.claude-agent-bridge.env]",
      "CLAUDE_CODE_PATH = \"claude\""
    ].join("\n"), "utf8");

    const result = await runInstallDoctor({
      codexConfigPath: configPath,
      exec: async (command: string) => ({
        code: 0,
        stdout: `${command} 1.0.0\n`,
        stderr: "",
        timedOut: false
      })
    });

    assert.equal(result.ok, true);
    assert.equal(result.codexConfig.exists, true);
    assert.equal(result.codexConfig.bridgeConfigured, true);
    assert.equal(result.codexConfig.dashboardConfigured, true);
    assert.equal(result.codexConfig.dashboardPort, 8787);
    assert.equal(result.providers.checks.every((check: { status?: string }) => check.status === "ready"), true);
    assert.deepEqual(result.nextSteps, []);
  });

  it("keeps MCP-only installs valid while recommending the unified dashboard runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-install-doctor-mcp-only-"));
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, [
      "[mcp_servers.claude-agent-bridge]",
      "command = \"node\"",
      "args = [\"/repo/dist/src/mcpServer.js\"]"
    ].join("\n"), "utf8");

    const result = await runInstallDoctor({
      codexConfigPath: configPath,
      exec: async (command: string) => ({
        code: 0,
        stdout: `${command} 1.0.0\n`,
        stderr: "",
        timedOut: false
      })
    });

    assert.equal(result.ok, true);
    assert.equal(result.codexConfig.bridgeConfigured, true);
    assert.equal(result.codexConfig.dashboardConfigured, false);
    assert.ok(result.nextSteps.some((step: string) => /unified MCP \+ Dashboard runtime/.test(step)));
  });

  it("returns actionable next steps for a missing Codex config and missing providers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-install-doctor-missing-"));
    const configPath = join(dir, "config.toml");

    const result = await runInstallDoctor({
      codexConfigPath: configPath,
      exec: async () => {
        const error = new Error("spawn provider ENOENT") as Error & { code?: string };
        error.code = "ENOENT";
        throw error;
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.codexConfig.exists, false);
    assert.equal(result.codexConfig.bridgeConfigured, false);
    assert.equal(result.codexConfig.dashboardConfigured, false);
    assert.ok(result.nextSteps.some((step: string) => /setup-codex --write/.test(step)));
    assert.ok(result.nextSteps.some((step: string) => /provider CLI paths/.test(step)));
  });
});
