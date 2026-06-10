import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CodexCliAgent, GeminiCliAgent, MyFlickerAgent, OpenCodeAgent } from "../src/agents/CliCodeAgent.js";

describe("CLI code agents", () => {
  it("runs Codex CLI non-interactively with workspace, model, and prompt on stdin", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-codex-cli-"));
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const agent = new CodexCliAgent({
      codexPath: "codex",
      exec: async (command, args, options) => {
        calls.push({ command, args, input: options.input });
        options.onStdoutChunk?.(`${JSON.stringify({ type: "message", text: "working" })}\n`);
        return {
          code: 0,
          stdout: "Codex finished",
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => ["index.html"]
    });

    const result = await agent.run({
      stage: "implement",
      agent: "codex-cli",
      workspace,
      request: "Create hello page",
      runId: "2026-05-20-codex-cli",
      model: "gpt-5.4",
      effort: "high"
    });

    assert.equal(result.ok, true);
    assert.equal(result.agent, "codex-cli");
    assert.equal(result.changedFiles[0], "index.html");
    assert.equal(calls[0].command, "codex");
    assert.deepEqual(calls[0].args.slice(0, 2), ["exec", "--json"]);
    assert.ok(calls[0].args.includes("--cd"));
    assert.ok(calls[0].args.includes(workspace));
    assert.ok(!calls[0].args.includes("--ask-for-approval"));
    assert.ok(calls[0].args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(calls[0].args.includes("--model"));
    assert.ok(calls[0].args.includes("gpt-5.4"));
    assert.ok(calls[0].args.includes("-"));
    assert.match(calls[0].input ?? "", /Stage: implement/);
    assert.equal(await readFile(result.outputPath ?? "", "utf8"), "Codex finished");
    assert.match(
      await readFile(join(workspace, ".agent-runs", "2026-05-20-codex-cli", "codex-cli-implement.stdout.log"), "utf8"),
      /Codex finished/
    );
  });

  it("runs Gemini CLI headlessly with stream output and stage-specific approval mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-gemini-cli-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const agent = new GeminiCliAgent({
      geminiPath: "gemini",
      exec: async (command, args, options) => {
        calls.push({ command, args });
        options.onStdoutChunk?.(`${JSON.stringify({ type: "result", result: "Gemini finished" })}\n`);
        return {
          code: 0,
          stdout: `${JSON.stringify({ type: "result", result: "Gemini finished" })}\n`,
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => []
    });

    const result = await agent.run({
      stage: "plan",
      agent: "gemini",
      workspace,
      request: "Plan a change",
      runId: "2026-05-20-gemini",
      model: "gemini-test"
    });

    assert.equal(result.ok, true);
    assert.equal(result.agent, "gemini");
    assert.equal(calls[0].command, "gemini");
    assert.ok(calls[0].args.includes("--prompt"));
    assert.ok(calls[0].args.includes("--output-format"));
    assert.ok(calls[0].args.includes("stream-json"));
    assert.ok(calls[0].args.includes("--approval-mode"));
    assert.ok(calls[0].args.includes("plan"));
    assert.ok(calls[0].args.includes("--model"));
    assert.ok(calls[0].args.includes("gemini-test"));
    assert.equal(await readFile(result.outputPath ?? "", "utf8"), "Gemini finished");
  });

  it("runs OpenCode headlessly with json output, workspace dir, and skipped permissions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-opencode-cli-"));
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const agent = new OpenCodeAgent({
      opencodePath: "opencode",
      exec: async (command, args, options) => {
        calls.push({ command, args, input: options.input });
        return {
          code: 0,
          stdout: `${JSON.stringify({ text: "OpenCode finished" })}\n`,
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => ["Makefile"]
    });

    const result = await agent.run({
      stage: "implement",
      agent: "opencode",
      workspace,
      request: "Create a Makefile",
      runId: "2026-05-20-opencode",
      model: "anthropic/claude-test"
    });

    assert.equal(result.ok, true);
    assert.equal(result.agent, "opencode");
    assert.equal(calls[0].command, "opencode");
    assert.deepEqual(calls[0].args.slice(0, 2), ["run", "--format"]);
    assert.ok(calls[0].args.includes("json"));
    assert.ok(calls[0].args.includes("--dir"));
    assert.ok(calls[0].args.includes(workspace));
    assert.ok(calls[0].args.includes("--dangerously-skip-permissions"));
    assert.ok(!calls[0].args.includes("--print"));
    assert.match(calls[0].args.at(-1) ?? "", /Stage: implement/);
    assert.equal(calls[0].input, "");
    assert.equal(await readFile(result.outputPath ?? "", "utf8"), "OpenCode finished");
  });

  it("runs MyFlicker headlessly with stream output, cwd, model, effort, and resume support", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-myflicker-cli-"));
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const agent = new MyFlickerAgent({
      myflickerPath: "m",
      exec: async (command, args, options) => {
        calls.push({ command, args, input: options.input });
        return {
          code: 0,
          stdout: [
            JSON.stringify({ session_id: "myflicker-session-1" }),
            JSON.stringify({ text: "MyFlicker finished" })
          ].join("\n"),
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => ["src/app.ts"]
    });

    const result = await agent.run({
      stage: "implement",
      agent: "myflicker",
      workspace,
      request: "Create an app",
      runId: "2026-06-02-myflicker",
      agentSessionId: "previous-session",
      model: "myflicker-test-model",
      effort: "high"
    });

    assert.equal(result.ok, true);
    assert.equal(result.agent, "myflicker");
    assert.equal(result.agentSessionId, "myflicker-session-1");
    assert.equal(result.resumeCommand, "'m' --resume 'myflicker-session-1'");
    assert.equal(calls[0].command, "m");
    assert.deepEqual(calls[0].args.slice(0, 5), ["-q", "--cwd", workspace, "--output-format", "stream-json"]);
    assert.ok(calls[0].args.includes("--approval-mode"));
    assert.ok(calls[0].args.includes("yolo"));
    assert.ok(calls[0].args.includes("--resume"));
    assert.ok(calls[0].args.includes("previous-session"));
    assert.ok(calls[0].args.includes("--model"));
    assert.ok(calls[0].args.includes("myflicker-test-model"));
    assert.ok(calls[0].args.includes("--thinking-level"));
    assert.ok(calls[0].args.includes("high"));
    assert.match(calls[0].args.at(-1) ?? "", /Stage: implement/);
    assert.equal(calls[0].input, "");
    assert.equal(await readFile(result.outputPath ?? "", "utf8"), "MyFlicker finished");
  });

  it("runs MyFlicker read-only stages with write tools disabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-myflicker-plan-"));
    const calls: Array<{ args: string[] }> = [];
    const agent = new MyFlickerAgent({
      exec: async (_command, args) => {
        calls.push({ args });
        return { code: 0, stdout: "Plan done", stderr: "", timedOut: false };
      },
      getChangedFiles: async () => []
    });

    await agent.run({
      stage: "plan",
      agent: "myflicker",
      workspace,
      request: "Plan the change",
      runId: "2026-06-02-myflicker-plan"
    });

    const toolsIndex = calls[0].args.indexOf("--tools");
    assert.ok(toolsIndex >= 0);
    assert.deepEqual(JSON.parse(calls[0].args[toolsIndex + 1]), {
      write: false,
      edit: false,
      bash: false,
      docs_write: false,
      docs_edit: false,
      todoWrite: false
    });
    assert.ok(!calls[0].args.includes("--approval-mode"));
  });
});
