import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createTaskTools, runClaudeStageTool } from "../src/mcp/tools.js";

describe("runClaudeStageTool", () => {
  it("returns structured content and text for successful Claude stages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-mcp-test-"));
    const result = await runClaudeStageTool(
      {
        stage: "plan",
        workspace,
        request: "Plan login cache",
        runId: "test-run"
      },
      {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "plan output" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.agent, "claude");
    assert.equal(result.content[0].type, "text");
    if (result.content[0].type === "text") {
      assert.match(result.content[0].text, /Claude plan completed/);
    }
  });

  it("returns tool errors as visible MCP results", async () => {
    const result = await runClaudeStageTool(
      {
        stage: "plan",
        workspace: "",
        request: "Plan login cache"
      },
      {
        claudePath: "claude"
      }
    );

    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, "text");
    if (result.content[0].type === "text") {
      assert.match(result.content[0].text, /workspace is required/);
    }
  });
});

describe("delegate task MCP tools", () => {
  it("runs synchronous delegated tasks with preferred agent routing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-delegate-test-"));
    const tools = createTaskTools({
      claude: {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "implemented" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.delegateTaskTool({
      mode: "sync",
      stages: ["implement"],
      preferredAgent: "claude",
      workspace,
      request: "Implement login cache",
      runId: "delegate-sync-run"
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.mode, "sync");
  });

  it("launches and cancels background delegated tasks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-delegate-bg-test-"));
    const tools = createTaskTools({
      claude: {
        claudePath: "claude",
        exec: async (_command, _args, options) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 100);
            options.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          });
          return {
            code: 0,
            stdout: JSON.stringify({ result: "done" }),
            stderr: "",
            timedOut: false
          };
        },
        getChangedFiles: async () => []
      }
    });

    const launched = await tools.delegateTaskTool({
      mode: "background",
      stages: ["implement"],
      preferredAgent: "claude",
      workspace,
      request: "Implement login cache",
      runId: "delegate-bg-run"
    });

    const taskId = String(launched.structuredContent?.taskId);
    assert.ok(taskId);

    const cancelled = await tools.taskCancelTool({ taskId });
    assert.equal(cancelled.structuredContent?.status, "cancelled");

    const status = await tools.taskStatusTool({ taskId });
    assert.equal(status.structuredContent?.status, "cancelled");
  });

  it("uses profiles to select stages and routing defaults", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-profile-test-"));
    const tools = createTaskTools({
      claude: {
        claudePath: "claude",
        exec: async (_command, _args, options) => ({
          code: 0,
          stdout: JSON.stringify({ result: `effort=${options.timeoutMs}` }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.delegateTaskTool({
      mode: "sync",
      profile: "heavy-coder",
      workspace,
      request: "Implement login cache",
      runId: "delegate-profile-run"
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.ok, true);
    const structured = result.structuredContent as { result?: { results?: Array<{ agent?: string; stage?: string }> } };
    assert.equal(structured.result?.results?.[0]?.agent, "claude");
    assert.equal(structured.result?.results?.[0]?.stage, "implement");
  });

  it("auto-classifies implementation requests when stage is omitted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-auto-test-"));
    const tools = createTaskTools({
      claude: {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "implemented" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.delegateTaskTool({
      mode: "sync",
      workspace,
      request: "Implement login cache",
      runId: "delegate-auto-run"
    });

    const structured = result.structuredContent as { result?: { results?: Array<{ agent?: string; stage?: string }> } };
    assert.equal(structured.result?.results?.[0]?.agent, "claude");
    assert.equal(structured.result?.results?.[0]?.stage, "implement");
  });

  it("lists task and agent catalog metadata", async () => {
    const tools = createTaskTools();

    const tasks = await tools.taskListTool();
    assert.equal(tasks.structuredContent?.ok, true);

    const catalog = await tools.agentCatalogTool();
    assert.equal(catalog.structuredContent?.ok, true);
    assert.ok(Array.isArray(catalog.structuredContent?.profiles));
  });
});
