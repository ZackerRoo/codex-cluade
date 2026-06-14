import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createTaskManager, createTaskTools, runClaudeStageTool, type TaskToolSet } from "../src/mcp/tools.js";
import { ProjectMemoryStore } from "../src/workflow/ProjectMemory.js";
import { TeamStore } from "../src/workflow/TeamStore.js";
import { TaskStore } from "../src/workflow/TaskStore.js";

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

  it("injects configured skills into direct Claude stage prompts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-mcp-skill-test-"));
    const inputs: Array<string | undefined> = [];
    const result = await runClaudeStageTool(
      {
        stage: "plan",
        workspace,
        request: "Plan a game",
        loadSkills: ["html-game"],
        runId: "test-skill-run"
      },
      {
        config: {
          skills: {
            "html-game": {
              content: "Use a single self-contained index.html file."
            }
          }
        },
        claudePath: "claude",
        exec: async (_command, _args, options) => {
          inputs.push(options.input);
          return {
            code: 0,
            stdout: JSON.stringify({ result: "plan output" }),
            stderr: "",
            timedOut: false
          };
        },
        getChangedFiles: async () => []
      }
    );

    assert.equal(result.isError, undefined);
    assert.match(inputs[0] ?? "", /## Injected skills/);
    assert.match(inputs[0] ?? "", /Use a single self-contained index\.html file/);
  });

  it("injects workspace context into direct Claude stage prompts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-mcp-context-test-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Context Demo\n", "utf8");
    await writeFile(join(workspace, "src", "service.ts"), "export function formatUser(name: string): string { return name; }\n", "utf8");
    const inputs: Array<string | undefined> = [];

    const result = await runClaudeStageTool(
      {
        stage: "analyze",
        workspace,
        request: "Summarize this project",
        runId: "test-context-run"
      },
      {
        claudePath: "claude",
        exec: async (_command, _args, options) => {
          inputs.push(options.input);
          return {
            code: 0,
            stdout: JSON.stringify({ result: "analysis output" }),
            stderr: "",
            timedOut: false
          };
        },
        getChangedFiles: async () => []
      }
    );

    assert.equal(result.isError, undefined);
    assert.match(inputs[0] ?? "", /## Workspace context/);
    assert.match(inputs[0] ?? "", /Context Demo/);
    assert.match(inputs[0] ?? "", /formatUser/);
    assert.match(inputs[0] ?? "", /code_symbols/);
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
  it("reports provider doctor status", async () => {
    const tools = await createTestTaskTools();

    const result = await tools.providerDoctorTool();

    assert.equal(typeof result.structuredContent?.ok, "boolean");
    const checks = result.structuredContent?.checks as Array<{ provider?: string; status?: string }> | undefined;
    assert.ok(checks?.some(check => check.provider === "claude"));
    assert.ok(checks?.some(check => check.provider === "codex-cli"));
    assert.ok(checks?.some(check => check.provider === "gemini"));
    assert.ok(checks?.some(check => check.provider === "opencode"));
    assert.ok(checks?.some(check => check.provider === "myflicker"));
  });

  it("lists and runs command templates", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-command-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "command implemented" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const catalog = await tools.commandCatalogTool();
    const commands = catalog.structuredContent?.commands as Array<{ name?: string }> | undefined;
    assert.ok(commands?.some(command => command.name === "start-work"));

    const result = await tools.runCommandTool({
      command: "/start-work build a hello page",
      workspace,
      runId: "command-run"
    });

    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.command, "start-work");
    assert.equal(result.structuredContent?.taskId, "command-run");
    const status = await tools.taskStatusTool({ taskId: "command-run" });
    assert.match(String(status.structuredContent?.request), /build a hello page/);
  });

  it("runs plan command templates through create_plan", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-plan-command-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "- [ ] Create index.html" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.runCommandTool({
      command: "plan-work",
      workspace,
      request: "Build hello page",
      planId: "command-plan"
    });

    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.command, "plan-work");
    assert.equal(result.structuredContent?.planId, "command-plan");
    const plan = await readFile(join(workspace, ".codex-claude", "plans", "command-plan.md"), "utf8");
    assert.match(plan, /Create index\.html/);
  });

  it("runs ultrawork as plan then parallel child execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-ultrawork-command-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async (_command, _args, options) => ({
          code: 0,
          stdout: JSON.stringify({
            result: (options.input ?? "").includes("Create an implementation plan")
              ? "- [ ] Create index.html\n- [ ] Add controls\n- [ ] Verify output"
              : "implemented from ultrawork plan"
          }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.runCommandTool({
      command: "/ultrawork build a dashboard",
      workspace,
      planId: "ultrawork-plan",
      runId: "ultrawork-run"
    });

    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.command, "ultrawork");
    assert.equal(result.structuredContent?.planId, "ultrawork-plan");
    assert.equal(result.structuredContent?.taskId, "ultrawork-run");
    assert.deepEqual(result.structuredContent?.childTaskIds, [
      "ultrawork-run-part-1",
      "ultrawork-run-part-2",
      "ultrawork-run-part-3",
      "ultrawork-run-review"
    ]);
    assert.equal(result.structuredContent?.reviewTaskId, "ultrawork-run-review");
    const status = await tools.taskStatusTool({ taskId: "ultrawork-run" });
    assert.deepEqual(status.structuredContent?.childTaskIds, [
      "ultrawork-run-part-1",
      "ultrawork-run-part-2",
      "ultrawork-run-part-3",
      "ultrawork-run-review"
    ]);
    assert.equal(status.structuredContent?.reviewTaskId, "ultrawork-run-review");
    assert.equal(status.structuredContent?.planId, "ultrawork-plan");
    const childStatus = await tools.taskStatusTool({ taskId: "ultrawork-run-part-1" });
    assert.equal(childStatus.structuredContent?.parentTaskId, "ultrawork-run");
    assert.equal(childStatus.structuredContent?.profile, "multi-coder");
    assert.match(String(childStatus.structuredContent?.request), /Create index\.html/);
    const reviewStatus = await tools.taskStatusTool({ taskId: "ultrawork-run-review" });
    assert.equal(reviewStatus.structuredContent?.parentTaskId, "ultrawork-run");
    assert.equal(reviewStatus.structuredContent?.profile, "momus");
    assert.deepEqual(reviewStatus.structuredContent?.dependsOnTaskIds, [
      "ultrawork-run-part-1",
      "ultrawork-run-part-2",
      "ultrawork-run-part-3"
    ]);
    await waitFor(() => {
      const completed = tools.taskStatusTool({ taskId: "ultrawork-run" });
      return completed.then(status => status.structuredContent?.status === "completed");
    });
    const output = await tools.backgroundOutputTool({ taskId: "ultrawork-run" });
    const artifact = (output.structuredContent?.artifacts as Array<{ path?: string; content?: string }> | undefined)
      ?.find(item => item.path === "workflow-output.md");
    assert.ok(artifact);
    assert.match(artifact.content ?? "", /ultrawork-run-review/);
    assert.match(artifact.content ?? "", /implemented from ultrawork plan/);
    const stateArtifact = (output.structuredContent?.artifacts as Array<{ path?: string; content?: string }> | undefined)
      ?.find(item => item.path === "workflow-state.md");
    assert.ok(stateArtifact);
    assert.match(stateArtifact.content ?? "", /Phase: completed/);
    assert.match(stateArtifact.content ?? "", /Next action: complete/);
    const plan = await readFile(join(workspace, ".codex-claude", "plans", "ultrawork-plan.md"), "utf8");
    assert.match(plan, /Create index\.html/);
  });

  it("adds web DOM verification automatically for ultrawork game requests", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-ultrawork-web-verify-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async (_command, _args, options) => ({
          code: 0,
          stdout: JSON.stringify({
            result: (options.input ?? "").includes("Create an implementation plan")
              ? "- [ ] Create index.html\n- [ ] Create app.js"
              : "implemented web game"
          }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.runCommandTool({
      command: "/ultrawork 实现一个末世网页游戏",
      workspace,
      planId: "ultrawork-web-plan",
      runId: "ultrawork-web-run"
    });

    assert.equal(result.structuredContent?.ok, true);
    const task = result.structuredContent?.task as { verifyCommand?: string } | undefined;
    assert.match(task?.verifyCommand ?? "", /verify-web/);
    assert.match(task?.verifyCommand ?? "", /#map > \*/);
    assert.match(task?.verifyCommand ?? "", /#action-grid button/);
  });

  it("caps long ultrawork plans into implementation batches", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-ultrawork-cap-test-"));
    const checklist = Array.from({ length: 10 }, (_, index) => `- [ ] Build module ${index + 1}`).join("\n");
    const tools = await createTestTaskTools({
      config: { workflow: { maxImplementationTasks: 4 } },
      claude: {
        claudePath: "claude",
        exec: async (_command, _args, options) => ({
          code: 0,
          stdout: JSON.stringify({
            result: (options.input ?? "").includes("Create an implementation plan")
              ? checklist
              : "implemented from capped ultrawork plan"
          }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.runCommandTool({
      command: "/ultrawork build a larger app",
      workspace,
      planId: "ultrawork-cap-plan",
      runId: "ultrawork-cap-run"
    });

    assert.equal(result.structuredContent?.ok, true);
    assert.deepEqual(result.structuredContent?.childTaskIds, [
      "ultrawork-cap-run-part-1",
      "ultrawork-cap-run-part-2",
      "ultrawork-cap-run-part-3",
      "ultrawork-cap-run-part-4",
      "ultrawork-cap-run-review"
    ]);
    const first = await tools.taskStatusTool({ taskId: "ultrawork-cap-run-part-1" });
    assert.match(String(first.structuredContent?.request), /Assigned implementation batch 1\/4/);
    assert.match(String(first.structuredContent?.request), /Build module 1/);
    assert.match(String(first.structuredContent?.request), /Build module 3/);
  });

  it("auto-dispatches simple implementation requests directly to the coder profile", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-auto-dispatch-direct-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "implemented tetris" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.autoDispatchTool({
      workspace,
      request: "让 Claude 写一个俄罗斯方块 HTML 游戏",
      runId: "auto-direct-run"
    });

    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.strategy, "direct");
    assert.equal(result.structuredContent?.taskId, "auto-direct-run");
    const status = await tools.taskStatusTool({ taskId: "auto-direct-run" });
    assert.equal(status.structuredContent?.profile, "coder");
    assert.deepEqual(status.structuredContent?.stages, ["implement"]);
  });

  it("auto-dispatches plan strategy through create plan then execute plan", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-auto-dispatch-plan-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async (_command, _args, options) => ({
          code: 0,
          stdout: JSON.stringify({
            result: (options.input ?? "").includes("Create an implementation plan")
              ? "- [ ] Create index.html\n- [ ] Verify the game"
              : "implemented from plan"
          }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.autoDispatchTool({
      workspace,
      request: "先规划再实现一个复杂的游戏",
      strategy: "plan",
      planId: "auto-plan",
      runId: "auto-plan-run"
    });

    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.strategy, "plan");
    assert.equal(result.structuredContent?.planId, "auto-plan");
    assert.equal(result.structuredContent?.taskId, "auto-plan-run");
    const plan = await readFile(join(workspace, ".codex-claude", "plans", "auto-plan.md"), "utf8");
    assert.match(plan, /Create index\.html/);
  });

  it("runs synchronous delegated tasks with preferred agent routing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-delegate-test-"));
    const tools = await createTestTaskTools({
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
    const tools = await createTestTaskTools({
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

  it("accepts verification options on background delegated tasks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-delegate-verify-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "done" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const launched = await tools.delegateTaskTool({
      mode: "background",
      stages: ["implement"],
      preferredAgent: "claude",
      workspace,
      request: "Implement login cache",
      runId: "delegate-verify-run",
      verifyCommand: `${process.execPath} -e "process.exit(0)"`,
      maxRepairAttempts: 0
    });

    assert.equal(launched.structuredContent?.ok, true);
    await waitFor(async () => {
      const status = await tools.taskStatusTool({ taskId: "delegate-verify-run" });
      return status.structuredContent?.status === "completed"
        && (status.structuredContent?.verification as { status?: string } | undefined)?.status === "passed";
    });

    const status = await tools.taskStatusTool({ taskId: "delegate-verify-run" });
    assert.match(String(status.content[0].type === "text" ? status.content[0].text : ""), /Verification: passed/);
    assert.match(String(status.content[0].type === "text" ? status.content[0].text : ""), /Quality: success/);
    assert.equal(status.structuredContent?.verifyCommand, `${process.execPath} -e "process.exit(0)"`);
  });

  it("reads background output artifacts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-output-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "done output" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const launched = await tools.delegateTaskTool({
      mode: "background",
      stages: ["implement"],
      preferredAgent: "claude",
      workspace,
      request: "Implement login cache",
      runId: "delegate-output-run"
    });
    const taskId = String(launched.structuredContent?.taskId);
    await new Promise(resolve => setTimeout(resolve, 20));

    const output = await tools.backgroundOutputTool({ taskId });
    assert.equal(output.structuredContent?.ok, true);
    assert.match(JSON.stringify(output.structuredContent), /done output/);
    assert.match(String(output.content[0].type === "text" ? output.content[0].text : ""), /# Delivery report/);
    assert.match(JSON.stringify(output.structuredContent), /deliveryReport/);
  });

  it("reads background output incrementally with a cursor", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-output-cursor-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "first chunk" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const launched = await tools.delegateTaskTool({
      mode: "background",
      stages: ["implement"],
      preferredAgent: "claude",
      workspace,
      request: "Implement login cache",
      runId: "delegate-cursor-run"
    });
    const taskId = String(launched.structuredContent?.taskId);
    await new Promise(resolve => setTimeout(resolve, 20));

    const first = await tools.backgroundOutputTool({ taskId, cursor: 0 });
    const firstCursor = Number(first.structuredContent?.nextCursor);
    assert.ok(firstCursor > 0);

    await writeFile(join(workspace, ".agent-runs", "delegate-cursor-run", "implement.output.md"), "first chunk\nsecond chunk", "utf8");
    const second = await tools.backgroundOutputTool({ taskId, cursor: firstCursor });

    assert.equal(second.structuredContent?.ok, true);
    assert.match(JSON.stringify(second.structuredContent), /second chunk/);
    assert.doesNotMatch(JSON.stringify(second.structuredContent), /first chunk/);
  });

  it("uses profiles to select stages and routing defaults", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-profile-test-"));
    const tools = await createTestTaskTools({
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
    const tools = await createTestTaskTools({
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
    const tools = await createTestTaskTools();

    const tasks = await tools.taskListTool();
    assert.equal(tasks.structuredContent?.ok, true);

    const catalog = await tools.agentCatalogTool();
    assert.equal(catalog.structuredContent?.ok, true);
    assert.ok(Array.isArray(catalog.structuredContent?.profiles));
    const agents = catalog.structuredContent?.agents as Array<{ name?: string }> | undefined;
    assert.ok(agents?.some(agent => agent.name === "codex-cli"));
    assert.ok(agents?.some(agent => agent.name === "gemini"));
    assert.ok(agents?.some(agent => agent.name === "opencode"));
    assert.ok(agents?.some(agent => agent.name === "myflicker"));
    const profiles = catalog.structuredContent?.profiles as Array<{ name?: string; rolePrompt?: string }> | undefined;
    assert.ok(profiles?.some(profile => profile.name === "myflicker-coder"));
    assert.ok(profiles?.some(profile => profile.name === "prometheus" && /Prometheus/.test(profile.rolePrompt ?? "")));
    assert.ok(profiles?.some(profile => profile.name === "sisyphus" && /Sisyphus/.test(profile.rolePrompt ?? "")));
    assert.ok(profiles?.some(profile => profile.name === "momus" && /Momus/.test(profile.rolePrompt ?? "")));
  });

  it("uses external config for profile routing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-config-test-"));
    const tools = await createTestTaskTools({
      config: {
        profiles: {
          "custom-coder": {
            description: "Custom coding profile",
            category: "coding",
            agent: "claude",
            stages: ["implement"],
            timeoutMs: 1234
          }
        }
      },
      claude: {
        claudePath: "claude",
        exec: async (_command, _args, options) => ({
          code: 0,
          stdout: JSON.stringify({ result: `timeout=${options.timeoutMs}` }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.delegateTaskTool({
      mode: "sync",
      profile: "custom-coder",
      workspace,
      request: "Implement login cache",
      runId: "delegate-config-run"
    });

    assert.equal(result.structuredContent?.ok, true);
    const structured = result.structuredContent as { result?: { results?: Array<{ agent?: string; stage?: string }> } };
    assert.equal(structured.result?.results?.[0]?.agent, "claude");
  });

  it("applies external profile permission policy to Claude runs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-permission-config-test-"));
    const calls: string[][] = [];
    const tools = await createTestTaskTools({
      config: {
        profiles: {
          "review-with-bash": {
            description: "Claude review with limited bash",
            category: "review",
            agent: "claude",
            stages: ["review"],
            permission: {
              mode: "default",
              allowedTools: ["Bash(git diff *)"],
              disallowedTools: ["Write", "Edit"]
            }
          }
        }
      },
      claude: {
        claudePath: "claude",
        exec: async (_command, args) => {
          calls.push(args);
          return {
            code: 0,
            stdout: JSON.stringify({ result: "reviewed" }),
            stderr: "",
            timedOut: false
          };
        },
        getChangedFiles: async () => []
      }
    });

    const result = await tools.delegateTaskTool({
      mode: "sync",
      profile: "review-with-bash",
      workspace,
      request: "Review current diff",
      runId: "delegate-permission-run"
    });

    assert.equal(result.structuredContent?.ok, true);
    assert.ok(calls[0].includes("--allowedTools"));
    assert.ok(calls[0].includes("Bash(git diff *)"));
    const disallowedIndex = calls[0].indexOf("--disallowedTools");
    assert.equal(calls[0][disallowedIndex + 1], "Write,Edit");
  });

  it("injects configured skills into delegated Claude prompts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-skill-test-"));
    const inputs: Array<string | undefined> = [];
    const tools = await createTestTaskTools({
      config: {
        skills: {
          "html-game": {
            content: "Use a single self-contained index.html file."
          }
        }
      },
      claude: {
        claudePath: "claude",
        exec: async (_command, _args, options) => {
          inputs.push(options.input);
          return {
            code: 0,
            stdout: JSON.stringify({ result: "implemented" }),
            stderr: "",
            timedOut: false
          };
        },
        getChangedFiles: async () => []
      }
    });

    const result = await tools.delegateTaskTool({
      mode: "sync",
      stage: "implement",
      preferredAgent: "claude",
      workspace,
      request: "Build a game",
      loadSkills: ["html-game"],
      runId: "delegate-skill-run"
    });

    assert.equal(result.structuredContent?.ok, true);
    assert.match(inputs[0] ?? "", /## Injected skills/);
    assert.match(inputs[0] ?? "", /Use a single self-contained index\.html file/);
  });

  it("creates a saved implementation plan", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-plan-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "- [ ] Create index.html\n- [ ] Verify the page text" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.createPlanTool({
      workspace,
      request: "Build hello page",
      planId: "hello-plan"
    });

    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.planId, "hello-plan");
    const planPath = String(result.structuredContent?.planPath);
    const plan = await readFile(planPath, "utf8");
    assert.match(plan, /Build hello page/);
    assert.match(plan, /Create index\.html/);
    assert.match(plan, /- \[ \] Verify the page text/);
  });

  it("executes a saved plan as a background task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-exec-plan-test-"));
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async (_command, _args, options) => {
          assert.match(options.input ?? "", /Plan file:/);
          assert.match(options.input ?? "", /Create index\.html/);
          return {
            code: 0,
            stdout: JSON.stringify({ result: "implemented plan" }),
            stderr: "",
            timedOut: false
          };
        },
        getChangedFiles: async () => []
      }
    });
    await writeFile(join(workspace, "plan.md"), "Create index.html", "utf8");

    const result = await tools.executePlanTool({
      mode: "background",
      workspace,
      planPath: "plan.md",
      runId: "execute-plan-run"
    });

    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.planId, "plan");
    assert.equal(result.structuredContent?.taskId, "execute-plan-run");
    const status = await tools.taskStatusTool({ taskId: "execute-plan-run" });
    assert.equal(status.structuredContent?.planId, "plan");
    assert.match(String(status.structuredContent?.planPath), /plan\.md$/);
  });

  it("returns plan checklist progress in background output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-plan-progress-test-"));
    const planPath = join(workspace, "plan.md");
    await writeFile(planPath, "- [x] Create index.html\n- [ ] Verify output", "utf8");
    const tools = await createTestTaskTools({
      claude: {
        claudePath: "claude",
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: "implemented plan" }),
          stderr: "",
          timedOut: false
        }),
        getChangedFiles: async () => []
      }
    });

    const result = await tools.executePlanTool({
      mode: "background",
      workspace,
      planPath,
      runId: "plan-progress-run"
    });
    assert.equal(result.structuredContent?.ok, true);
    await new Promise(resolve => setTimeout(resolve, 20));

    const output = await tools.backgroundOutputTool({ taskId: "plan-progress-run" });
    const structured = output.structuredContent as { planSummary?: { totalSteps?: number; completedSteps?: number; progressPercent?: number } };
    assert.equal(structured.planSummary?.totalSteps, 2);
    assert.equal(structured.planSummary?.completedSteps, 1);
    assert.equal(structured.planSummary?.progressPercent, 50);
  });

  it("reads project memory for a workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-project-memory-tool-test-"));
    await new ProjectMemoryStore(workspace).recordTask({
      id: "memory-tool-task",
      mode: "background",
      status: "completed",
      workspace,
      request: "Remember API conventions",
      stages: ["implement"],
      preferredAgent: "claude",
      runId: "memory-tool-run",
      createdAt: "2026-06-04T08:00:00.000Z",
      updatedAt: "2026-06-04T08:01:00.000Z",
      resultSummary: {
        kind: "task",
        status: "completed",
        stages: ["implement"],
        summary: "Use repository service helpers for API calls.",
        changedFiles: ["src/api.ts"],
        agentSessions: [],
        durationMs: 1000,
        nextSteps: [],
        providerAttempts: ["claude"]
      }
    });
    const tools = await createTestTaskTools();

    const result = await tools.projectMemoryTool({ workspace });

    assert.equal(result.structuredContent?.ok, true);
    const entries = result.structuredContent?.entries as Array<{ taskId?: string; summary?: string }> | undefined;
    assert.equal(entries?.[0]?.taskId, "memory-tool-task");
    assert.match(entries?.[0]?.summary ?? "", /repository service helpers/);
    assert.match(String(result.content[0].type === "text" ? result.content[0].text : ""), /# Project memory/);
  });

  it("manages Team Mode messages and shared tasks", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bridge-team-tool-test-"));
    const tools = await createTestTaskTools({ teamStore: new TeamStore({ rootDir }) });

    const created = await tools.teamCreateTool({
      teamId: "team-tool",
      workspace: "/tmp/project",
      goal: "Fix login bug",
      members: [
        { id: "lead", role: "lead", profile: "sisyphus" },
        { id: "coder", role: "implementation", profile: "coder", agent: "claude" }
      ]
    });
    assert.equal(created.structuredContent?.ok, true);

    const task = await tools.teamTaskCreateTool({
      teamId: "team-tool",
      title: "Inspect auth flow",
      assignee: "coder"
    });
    const taskId = (task.structuredContent?.task as { id?: string } | undefined)?.id;
    assert.equal(taskId, "team-tool-task-1");

    const message = await tools.teamSendMessageTool({
      teamId: "team-tool",
      from: "lead",
      to: "coder",
      taskId,
      body: "Please inspect auth flow and report root cause."
    });
    assert.match(String(message.content[0].type === "text" ? message.content[0].text : ""), /Please inspect auth flow/);

    const inbox = await tools.teamInboxTool({ teamId: "team-tool", memberId: "coder" });
    assert.equal((inbox.structuredContent?.messages as unknown[] | undefined)?.length, 1);

    const updated = await tools.teamTaskUpdateTool({ teamId: "team-tool", taskId: taskId!, status: "in_progress", linkedTaskId: "delegate-1" });
    assert.equal((updated.structuredContent?.task as { status?: string; linkedTaskId?: string } | undefined)?.status, "in_progress");
    assert.equal((updated.structuredContent?.task as { status?: string; linkedTaskId?: string } | undefined)?.linkedTaskId, "delegate-1");

    const status = await tools.teamStatusTool({ teamId: "team-tool" });
    assert.match(String(status.content[0].type === "text" ? status.content[0].text : ""), /Messages: 1/);
    assert.match(String(status.content[0].type === "text" ? status.content[0].text : ""), /Tasks: 1/);

    const list = await tools.teamListTool();
    assert.equal(list.structuredContent?.ok, true);
    assert.equal(((list.structuredContent?.teams as Array<{ id?: string }> | undefined) ?? [])[0]?.id, "team-tool");
  });

  it("starts a Team Mode task as a delegated task and links it back", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bridge-team-start-test-"));
    const taskStore = new TaskStore({ rootDir: join(rootDir, "tasks") });
    const manager = createTaskManager({
      taskStore,
      claude: {
        claudePath: "claude",
        exec: async () => ({ code: 0, stdout: JSON.stringify({ result: "implemented team task" }), stderr: "", timedOut: false }),
        getChangedFiles: async () => []
      }
    });
    const tools = await createTestTaskTools({
      taskManager: manager,
      teamStore: new TeamStore({ rootDir: join(rootDir, "teams") })
    });

    await tools.teamCreateTool({
      teamId: "team-start",
      workspace: "/tmp/project",
      goal: "Ship a feature",
      members: [{ id: "coder", role: "implementation", agent: "claude" }]
    });
    const createdTask = await tools.teamTaskCreateTool({ teamId: "team-start", title: "Implement feature", assignee: "coder" });
    const teamTaskId = (createdTask.structuredContent?.task as { id?: string } | undefined)?.id;

    const started = await tools.teamTaskStartTool({ teamId: "team-start", taskId: teamTaskId!, mode: "background" });

    assert.equal(started.structuredContent?.ok, true);
    const delegatedTaskId = (started.structuredContent as { delegatedTaskId?: string }).delegatedTaskId;
    assert.ok(delegatedTaskId);
    const status = await tools.teamStatusTool({ teamId: "team-start" });
    const team = (status.structuredContent as { team?: { tasks?: Array<{ linkedTaskId?: string; status?: string }>; messages?: unknown[] } }).team;
    assert.equal(team?.tasks?.[0]?.linkedTaskId, delegatedTaskId);
    assert.equal(team?.tasks?.[0]?.status, "in_progress");
    assert.equal(team?.messages?.length, 1);
  });

  it("syncs Team Mode task status from linked delegated tasks", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bridge-team-sync-test-"));
    const taskStore = new TaskStore({ rootDir: join(rootDir, "tasks") });
    taskStore.save({
      id: "linked-completed-task",
      mode: "background",
      status: "completed",
      workspace: "/tmp/project",
      request: "Linked completed task",
      stages: ["implement"],
      runId: "linked-completed-task",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:01.000Z"
    });
    const tools = createTaskTools({
      taskStore,
      teamStore: new TeamStore({ rootDir: join(rootDir, "teams") })
    });
    await tools.teamCreateTool({
      teamId: "team-sync",
      workspace: "/tmp/project",
      goal: "Sync linked task status",
      members: [{ id: "coder", role: "implementation", agent: "claude" }]
    });
    const created = await tools.teamTaskCreateTool({ teamId: "team-sync", title: "Complete linked work", assignee: "coder" });
    const teamTaskId = (created.structuredContent?.task as { id?: string } | undefined)?.id;
    await tools.teamTaskUpdateTool({ teamId: "team-sync", taskId: teamTaskId!, status: "in_progress", linkedTaskId: "linked-completed-task" });

    const status = await tools.teamStatusTool({ teamId: "team-sync" });
    const content = status.structuredContent as { team?: { tasks?: Array<{ status?: string }> ; messages?: unknown[] }; linkedTasks?: Array<{ id?: string; status?: string }> };

    assert.equal(content.team?.tasks?.[0]?.status, "done");
    assert.equal(content.linkedTasks?.[0]?.id, "linked-completed-task");
    assert.equal(content.linkedTasks?.[0]?.status, "completed");
    assert.equal(content.team?.messages?.length, 1);
  });

  it("creates Team Mode work from templates and runs the coordinator", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bridge-team-template-test-"));
    const manager = createTaskManager({
      taskStore: new TaskStore({ rootDir: join(rootDir, "tasks") }),
      claude: {
        claudePath: "claude",
        exec: async () => ({ code: 0, stdout: JSON.stringify({ result: "coordinated team task" }), stderr: "", timedOut: false }),
        getChangedFiles: async () => []
      }
    });
    const tools = createTaskTools({
      taskManager: manager,
      teamStore: new TeamStore({ rootDir: join(rootDir, "teams") })
    });

    const templates = await tools.teamTemplatesTool();
    assert.ok((templates.structuredContent as { templates?: Array<{ name?: string }> }).templates?.some(template => template.name === "bugfix-team"));

    const created = await tools.teamCreateFromTemplateTool({
      teamId: "template-team",
      template: "bugfix-team",
      workspace: "/tmp/project",
      goal: "Fix a login bug",
      autoStart: false
    });
    const team = (created.structuredContent as { team?: { tasks?: unknown[]; budget?: { maxRunning?: number } } }).team;
    assert.equal(team?.tasks?.length, 3);
    assert.equal(team?.budget?.maxRunning, 2);

    const coordinated = await tools.teamCoordinatorRunTool({ teamId: "template-team", autoStart: true, autoMerge: true, maxStarts: 1 });
    const coordinatedContent = coordinated.structuredContent as { startedTaskIds?: string[]; team?: { coordinator?: { phase?: string } } };
    assert.equal(coordinatedContent.startedTaskIds?.length, 1);
    assert.equal(coordinatedContent.team?.coordinator?.phase, "running");
  });

  it("runs a Team Mode communication round and records member messages", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bridge-team-round-test-"));
    const tools = createTaskTools({ teamStore: new TeamStore({ rootDir }) });
    await tools.teamCreateTool({
      teamId: "round-team",
      workspace: "/tmp/project",
      goal: "Design a stable import pipeline",
      members: [
        { id: "planner", role: "planning", profile: "planner", agent: "codex-cli" },
        { id: "coder", role: "implementation", profile: "coder", agent: "claude" },
        { id: "reviewer", role: "review", profile: "reviewer", agent: "codex-cli" },
        { id: "merger", role: "merge", profile: "coder", agent: "claude" }
      ]
    });
    await tools.teamTaskCreateTool({ teamId: "round-team", title: "Draft import plan", assignee: "planner" });

    const round = await tools.teamRoundRunTool({
      teamId: "round-team",
      topic: "Agree on implementation plan and risks",
      participants: ["planner", "coder", "reviewer", "merger"]
    });

    assert.equal(round.structuredContent?.ok, true);
    const content = round.structuredContent as {
      round?: { id?: string; participantCount?: number; messages?: Array<{ from?: string; body?: string }> };
      team?: { coordinator?: { phase?: string; lastAction?: string }; messages?: Array<{ from?: string; body?: string }> };
    };
    assert.equal(content.round?.participantCount, 4);
    assert.ok(content.round?.id);
    assert.deepEqual(content.round?.messages?.map(message => message.from), ["planner", "coder", "reviewer", "merger"]);
    assert.match(content.round?.messages?.[0]?.body ?? "", /Round/);
    assert.equal(content.team?.coordinator?.phase, "running");
    assert.match(content.team?.coordinator?.lastAction ?? "", /communication round/);
    assert.equal(content.team?.messages?.length, 4);
  });

  it("enforces Team Mode allowed-agent budget", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bridge-team-budget-test-"));
    const tools = createTaskTools({ teamStore: new TeamStore({ rootDir }) });
    await tools.teamCreateTool({
      teamId: "budget-team",
      workspace: "/tmp/project",
      goal: "Respect budget",
      budget: { allowedAgents: ["codex-cli"] },
      members: [{ id: "coder", role: "implementation", agent: "claude" }]
    });
    const created = await tools.teamTaskCreateTool({ teamId: "budget-team", title: "Implement disallowed agent task", assignee: "coder" });
    const taskId = (created.structuredContent?.task as { id?: string } | undefined)?.id;

    const started = await tools.teamTaskStartTool({ teamId: "budget-team", taskId: taskId!, mode: "background" });

    assert.equal(started.isError, true);
    assert.match(String(started.content[0].type === "text" ? started.content[0].text : ""), /not allowed by team budget/);
  });
});

async function createTestTaskTools(options: Parameters<typeof createTaskTools>[0] = {}): Promise<TaskToolSet> {
  const rootDir = await mkdtemp(join(tmpdir(), "bridge-mcp-task-store-"));
  return createTaskTools({
    ...options,
    taskStore: new TaskStore({ rootDir }),
    teamStore: options.teamStore ?? new TeamStore({ rootDir: join(rootDir, "teams") })
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for condition");
}
