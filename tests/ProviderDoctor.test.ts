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
        opencodePath: "/tmp/opencode",
        myflickerPath: "/tmp/m"
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
    assert.deepEqual(calls.slice(0, 5).map(call => call.command), ["/tmp/claude", "/tmp/codex", "/tmp/gemini", "/tmp/opencode", "/tmp/m"]);
    assert.ok(calls.slice(0, 5).every(call => call.args.includes("--version")));
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

  it("probes the bridge default Claude model when requested", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const doctor = new ProviderDoctor({
      env: { CODEX_CLAUDE_SETTINGS_PATH: "/tmp/codex-claude-missing-settings.json" },
      probeModels: true,
      exec: async (command, args) => {
        calls.push({ command, args });
        if (command === "claude" && args.includes("-p")) {
          return {
            code: 0,
            stdout: [
              JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-8" }),
              JSON.stringify({ type: "result", is_error: false, result: "ok" })
            ].join("\n"),
            stderr: "",
            timedOut: false
          };
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
    const claude = result.checks.find(check => check.provider === "claude");

    assert.equal(result.ok, true);
    assert.equal(claude?.status, "ready");
    assert.equal(claude?.model, "claude-opus-4-8");
    assert.equal(claude?.modelStatus, "ready");
    const probe = calls.find(call => call.command === "claude" && call.args.includes("-p"));
    const modelIndex = probe?.args.indexOf("--model") ?? -1;
    assert.notEqual(modelIndex, -1);
    assert.equal(probe?.args[modelIndex + 1], "opus[1m]");
  });

  it("reports Claude rate limit retries before probe timeout", async () => {
    const doctor = new ProviderDoctor({
      env: { CODEX_CLAUDE_SETTINGS_PATH: "/tmp/codex-claude-missing-settings.json" },
      probeModels: true,
      exec: async (command, args) => {
        if (command === "claude" && args.includes("-p")) {
          return {
            code: 0,
            stdout: [
              JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-8[1m]" }),
              JSON.stringify({ type: "system", subtype: "api_retry", error: "rate_limit", error_status: 429 })
            ].join("\n"),
            stderr: "",
            timedOut: true
          };
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
    const claude = result.checks.find(check => check.provider === "claude");

    assert.equal(result.ok, false);
    assert.equal(claude?.model, "claude-opus-4-8[1m]");
    assert.equal(claude?.modelStatus, "failed");
    assert.equal(claude?.modelError, "rate_limit (429); model probe timed out");
  });

  it("reports Claude model probe failures separately from CLI availability", async () => {
    const doctor = new ProviderDoctor({
      probeModels: true,
      exec: async (command, args) => {
        if (command === "claude" && args.includes("-p")) {
          return {
            code: 0,
            stdout: [
              JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-8[1m]" }),
              JSON.stringify({ type: "result", is_error: true, result: "model_not_found" })
            ].join("\n"),
            stderr: "",
            timedOut: false
          };
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
    const claude = result.checks.find(check => check.provider === "claude");

    assert.equal(result.ok, false);
    assert.equal(claude?.status, "ready");
    assert.equal(claude?.model, "claude-opus-4-8[1m]");
    assert.equal(claude?.modelStatus, "failed");
    assert.equal(claude?.modelError, "model_not_found");
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
