import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderDoctor } from "../src/doctor/ProviderDoctor.js";

describe("ProviderDoctor", () => {
  it("reports ready providers with version output", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const doctor = new ProviderDoctor({
      config: {
        claudePath: "/tmp/claude",
        codexPath: "/tmp/codex",
        geminiPath: "/tmp/gemini",
        opencodePath: "/tmp/opencode"
      },
      exec: async (command, args) => {
        calls.push({ command, args });
        return {
          code: 0,
          stdout: `${command} 1.2.3\n`,
          stderr: "",
          timedOut: false
        };
      }
    });

    const result = await doctor.check();

    assert.equal(result.ok, true);
    assert.deepEqual(calls.slice(0, 4).map(call => call.command), ["/tmp/claude", "/tmp/codex", "/tmp/gemini", "/tmp/opencode"]);
    assert.ok(calls.slice(0, 4).every(call => call.args.includes("--version")));
    assert.equal(result.checks[0].status, "ready");
    assert.equal(result.checks[0].version, "/tmp/claude 1.2.3");
  });

  it("reports language server availability separately from AI providers", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const doctor = new ProviderDoctor({
      env: {
        PYRIGHT_LANGSERVER_PATH: "/tmp/pyright",
        CLANGD_PATH: "/tmp/clangd"
      },
      exec: async (command, args) => {
        calls.push({ command, args });
        if (command === "jdtls") {
          const error = new Error("spawn jdtls ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return {
          code: 0,
          stdout: `${command} version\n`,
          stderr: "",
          timedOut: false
        };
      }
    });

    const result = await doctor.check();
    const byLanguage = Object.fromEntries(result.languageServers.map(check => [check.language, check]));

    assert.ok(calls.some(call => call.command === "/tmp/pyright" && call.args.includes("--version")));
    assert.ok(calls.some(call => call.command === "/tmp/clangd" && call.args.includes("--version")));
    assert.equal(byLanguage.python.status, "ready");
    assert.equal(byLanguage.java.status, "missing");
    assert.equal(byLanguage.cpp.status, "ready");
  });

  it("classifies missing and failed providers", async () => {
    const doctor = new ProviderDoctor({
      exec: async command => {
        if (command === "claude") {
          const error = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return {
          code: command === "codex" ? 2 : 0,
          stdout: command === "codex" ? "" : `${command} ok`,
          stderr: command === "codex" ? "not logged in" : "",
          timedOut: false
        };
      }
    });

    const result = await doctor.check();
    const byProvider = Object.fromEntries(result.checks.map(check => [check.provider, check]));

    assert.equal(result.ok, false);
    assert.equal(byProvider.claude.status, "missing");
    assert.equal(byProvider["codex-cli"].status, "failed");
    assert.equal(byProvider["codex-cli"].error, "not logged in");
    assert.equal(byProvider.gemini.status, "ready");
  });

  it("treats language servers that reject --version as available", async () => {
    const doctor = new ProviderDoctor({
      exec: async command => ({
        code: command === "sourcekit-lsp" ? 64 : 0,
        stdout: "",
        stderr: command === "sourcekit-lsp" ? "Error: Unknown option '--version'" : `${command} ok`,
        timedOut: false
      })
    });

    const result = await doctor.check();
    const swift = result.languageServers.find(check => check.language === "swift");

    assert.equal(swift?.status, "ready");
    assert.equal(swift?.version, "available; version flag unsupported");
  });
});
