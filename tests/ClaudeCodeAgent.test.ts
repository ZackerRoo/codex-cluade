import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ClaudeCodeAgent } from "../src/agents/ClaudeCodeAgent.js";

describe("ClaudeCodeAgent", () => {
  it("runs claude plan stage without Claude Code plan approval mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const calls: string[][] = [];
    const inputs: Array<string | undefined> = [];
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async (_command: string, args: string[], options) => {
        calls.push(args);
        inputs.push(options.input);
        return {
          code: 0,
          stdout: JSON.stringify({ result: "plan output" }),
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => []
    });

    const result = await agent.run({
      stage: "plan",
      agent: "claude",
      workspace,
      request: "Add login cache",
      runId: "2026-05-16-001"
    });

    assert.equal(result.ok, true);
    assert.match(result.summary, /completed/);
    assert.ok(result.outputPath);
    assert.equal(await readFile(result.outputPath, "utf8"), "plan output");
    assert.ok(calls[0].includes("-p"));
    assert.ok(calls[0].includes("--output-format"));
    assert.ok(calls[0].includes("stream-json"));
    assert.ok(calls[0].includes("--verbose"));
    assert.ok(calls[0].includes("--include-partial-messages"));
    assert.ok(calls[0].includes("--permission-mode"));
    assert.ok(calls[0].includes("default"));
    assert.ok(!calls[0].includes("plan"));
    const disallowedIndex = calls[0].indexOf("--disallowedTools");
    assert.notEqual(disallowedIndex, -1);
    assert.equal(calls[0][disallowedIndex + 1], "Edit,Write,NotebookEdit");
    assert.doesNotMatch(calls[0].at(-1) ?? "", /Stage: plan/);
    assert.match(inputs[0] ?? "", /Stage: plan/);
  });

  it("persists raw Claude CLI stdout and stderr while extracting the final stream result", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async (_command: string, _args: string[], options) => {
        options.onStdoutChunk?.(`${JSON.stringify({ type: "assistant", delta: "working" })}\n`);
        options.onStdoutChunk?.(`${JSON.stringify({ type: "result", result: "final streamed result" })}\n`);
        options.onStderrChunk?.("stderr chunk\n");
        return {
          code: 0,
          stdout: [
            JSON.stringify({ type: "assistant", delta: "working" }),
            JSON.stringify({ type: "result", result: "final streamed result" })
          ].join("\n"),
          stderr: "stderr chunk\n",
          timedOut: false
        };
      },
      getChangedFiles: async () => []
    });

    const result = await agent.run({
      stage: "implement",
      agent: "claude",
      workspace,
      request: "Stream work",
      runId: "2026-05-16-stream"
    });

    assert.equal(result.ok, true);
    assert.equal(await readFile(result.outputPath ?? "", "utf8"), "final streamed result");
    const runDir = join(workspace, ".agent-runs", "2026-05-16-stream");
    assert.match(await readFile(join(runDir, "claude-implement.stdout.jsonl"), "utf8"), /final streamed result/);
    assert.equal(await readFile(join(runDir, "claude-implement.stderr.log"), "utf8"), "stderr chunk\n");
  });

  it("runs claude implement stage with full permissions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const sessionId = "57a91bf5-6a80-43c7-93d0-4095a19b4302";
    const calls: string[][] = [];
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ result: "implemented", session_id: sessionId }),
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => ["src/example.ts"]
    });

    const result = await agent.run({
      stage: "implement",
      agent: "claude",
      workspace,
      request: "Add login cache",
      runId: "2026-05-16-002"
    });

    assert.equal(result.ok, true);
    assert.equal(result.changedFiles[0], "src/example.ts");
    assert.equal(result.agentSessionId, sessionId);
    assert.match(result.resumeCommand ?? "", new RegExp(`claude' --resume ${sessionId}$`));
    assert.ok(calls[0].includes("--permission-mode"));
    assert.ok(calls[0].includes("bypassPermissions"));
    assert.ok(!calls[0].includes("--disallowedTools"));
  });

  it("passes the bridge default Claude model when no model is requested", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const settingsPath = join(workspace, "claude-settings.json");
    await writeFile(settingsPath, JSON.stringify({ model: "opus[1m]" }), "utf8");
    const previousModel = process.env.CODEX_CLAUDE_MODEL;
    const previousSettingsPath = process.env.CODEX_CLAUDE_SETTINGS_PATH;
    delete process.env.CODEX_CLAUDE_MODEL;
    process.env.CODEX_CLAUDE_SETTINGS_PATH = settingsPath;
    const calls: string[][] = [];
    try {
      const agent = new ClaudeCodeAgent({
        claudePath: "claude",
        exec: async (_command: string, args: string[]) => {
          calls.push(args);
          return {
            code: 0,
            stdout: JSON.stringify({ result: "implemented" }),
            stderr: "",
            timedOut: false
          };
        },
        getChangedFiles: async () => []
      });

      await agent.run({
        stage: "implement",
        agent: "claude",
        workspace,
        request: "Add login cache",
        runId: "2026-05-16-default-model"
      });

      const modelIndex = calls[0].indexOf("--model");
      assert.notEqual(modelIndex, -1);
      assert.equal(calls[0][modelIndex + 1], "opus[1m]");
    } finally {
      if (previousModel === undefined) delete process.env.CODEX_CLAUDE_MODEL;
      else process.env.CODEX_CLAUDE_MODEL = previousModel;
      if (previousSettingsPath === undefined) delete process.env.CODEX_CLAUDE_SETTINGS_PATH;
      else process.env.CODEX_CLAUDE_SETTINGS_PATH = previousSettingsPath;
    }
  });

  it("passes configured default Claude model when provided", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const calls: string[][] = [];
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      defaultModel: "claude-opus-4-8",
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ result: "implemented" }),
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => []
    });

    await agent.run({
      stage: "implement",
      agent: "claude",
      workspace,
      request: "Add login cache",
      runId: "2026-05-16-configured-model"
    });

    const modelIndex = calls[0].indexOf("--model");
    assert.notEqual(modelIndex, -1);
    assert.equal(calls[0][modelIndex + 1], "claude-opus-4-8");
  });

  it("lets explicit model override the configured default Claude model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const calls: string[][] = [];
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      defaultModel: "claude-opus-4-8",
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ result: "implemented" }),
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => []
    });

    await agent.run({
      stage: "implement",
      agent: "claude",
      workspace,
      request: "Add login cache",
      runId: "2026-05-16-explicit-model",
      model: "custom-claude-model"
    });

    const modelIndex = calls[0].indexOf("--model");
    assert.notEqual(modelIndex, -1);
    assert.equal(calls[0][modelIndex + 1], "custom-claude-model");
  });

  it("passes agentSessionId to Claude resume", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const sessionId = "57a91bf5-6a80-43c7-93d0-4095a19b4302";
    const calls: string[][] = [];
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ result: "continued", session_id: sessionId }),
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => []
    });

    await agent.run({
      stage: "implement",
      agent: "claude",
      workspace,
      request: "Continue implementation",
      runId: "2026-05-16-continued",
      agentSessionId: sessionId
    });

    const resumeIndex = calls[0].indexOf("--resume");
    assert.notEqual(resumeIndex, -1);
    assert.equal(calls[0][resumeIndex + 1], sessionId);
  });

  it("uses explicit permission policy when provided", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const calls: string[][] = [];
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ result: "planned" }),
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => []
    });

    await agent.run({
      stage: "plan",
      agent: "claude",
      workspace,
      request: "Plan with read tools",
      runId: "2026-05-16-permissions",
      permission: {
        mode: "bypassPermissions",
        allowedTools: ["Bash(ls *)"],
        disallowedTools: ["Write"]
      }
    });

    const permissionIndex = calls[0].indexOf("--permission-mode");
    assert.equal(calls[0][permissionIndex + 1], "bypassPermissions");
    const allowedIndex = calls[0].indexOf("--allowedTools");
    assert.notEqual(allowedIndex, -1);
    assert.equal(calls[0][allowedIndex + 1], "Bash(ls *)");
    const disallowedIndex = calls[0].indexOf("--disallowedTools");
    assert.notEqual(disallowedIndex, -1);
    assert.equal(calls[0][disallowedIndex + 1], "Write");
  });

  it("returns explicit error when claude exits non-zero with empty stdout and stderr", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async () => ({
        code: 1,
        stdout: "",
        stderr: "",
        timedOut: false
      }),
      getChangedFiles: async () => []
    });

    const result = await agent.run({
      stage: "plan",
      agent: "claude",
      workspace,
      request: "Add login cache",
      runId: "2026-05-16-003"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.ok(result.error, "expected an error message to be set");
    assert.match(result.error ?? "", /no output/i);
    assert.match(result.error ?? "", /empty stdout and stderr/i);
    assert.ok(
      (result.error ?? "").includes(result.logPath ?? ""),
      "expected error to reference log path"
    );
  });

  it("preserves stderr as error when claude exits non-zero with stderr", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async () => ({
        code: 2,
        stdout: "",
        stderr: "boom: something went wrong",
        timedOut: false
      }),
      getChangedFiles: async () => []
    });

    const result = await agent.run({
      stage: "plan",
      agent: "claude",
      workspace,
      request: "Add login cache",
      runId: "2026-05-16-004"
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "boom: something went wrong");
  });

  it("preserves stream result as error when claude exits non-zero with empty stderr", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async () => ({
        code: 1,
        stdout: JSON.stringify({ type: "result", result: "API Error: role 'system' is not supported on this model" }),
        stderr: "",
        timedOut: false
      }),
      getChangedFiles: async () => []
    });

    const result = await agent.run({
      stage: "implement",
      agent: "claude",
      workspace,
      request: "Fix npm test",
      runId: "2026-05-16-stdout-error"
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "API Error: role 'system' is not supported on this model");
  });

  it("reports timeout error without being shadowed by empty-output handling", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async () => ({
        code: 1,
        stdout: "",
        stderr: "",
        timedOut: true
      }),
      getChangedFiles: async () => []
    });

    const result = await agent.run({
      stage: "plan",
      agent: "claude",
      workspace,
      request: "Add login cache",
      runId: "2026-05-16-005"
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "Claude command timed out");
  });
});
