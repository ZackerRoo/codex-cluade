import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInstallSmoke } from "../src/install/InstallSmoke.js";

describe("runInstallSmoke", () => {
  it("packs, installs, and exercises installed bin entrypoints", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const result = await runInstallSmoke({
      cwd: "/repo",
      tempRoot: "/tmp/install-smoke",
      mkdtemp: async (prefix: string) => `${prefix}abc123`,
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      exec: async (command: string, args: string[], options: { cwd: string }) => {
        calls.push({ command, args, cwd: options.cwd });
        if (args.includes("pack")) {
          return {
            code: 0,
            stdout: JSON.stringify([{ filename: "codex-claude-agent-bridge-0.1.0.tgz" }]),
            stderr: "",
            timedOut: false
          };
        }
        if (args.includes("--port") && args.includes("0")) {
          return { code: 1, stdout: "", stderr: "--port must be a positive integer", timedOut: false };
        }
        return { code: 0, stdout: "{}", stderr: "", timedOut: false };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.every((check: { ok: boolean }) => check.ok), true);
    assert.ok(calls.some(call => call.command === "npm" && call.args.includes("pack")));
    assert.ok(calls.some(call => call.command === "npm" && call.args.includes("install")));
    assert.ok(calls.some(call => call.command.endsWith("claude-agent-bridge") && call.args.includes("setup-codex")));
    assert.ok(calls.some(call => call.command.endsWith("claude-agent-bridge") && call.args.includes("doctor")));
    assert.ok(calls.some(call => call.command.endsWith("claude-agent-bridge-dashboard")));
    assert.ok(calls.some(call => call.command.endsWith("claude-agent-bridge-mcp-dashboard")));
  });

  it("fails when npm install of the packed tarball fails", async () => {
    const result = await runInstallSmoke({
      cwd: "/repo",
      tempRoot: "/tmp/install-smoke",
      mkdtemp: async (prefix: string) => `${prefix}abc123`,
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      exec: async (_command: string, args: string[]) => {
        if (args.includes("pack")) {
          return {
            code: 0,
            stdout: JSON.stringify([{ filename: "codex-claude-agent-bridge-0.1.0.tgz" }]),
            stderr: "",
            timedOut: false
          };
        }
        if (args.includes("install")) {
          return { code: 1, stdout: "", stderr: "install failed", timedOut: false };
        }
        return { code: 0, stdout: "{}", stderr: "", timedOut: false };
      }
    });

    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check: { name: string; ok: boolean; detail?: string }) =>
      check.name === "npm-install" && !check.ok && /install failed/.test(check.detail ?? "")
    ));
  });
});
