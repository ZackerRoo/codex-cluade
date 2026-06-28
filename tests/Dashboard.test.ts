import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createTaskManager, createTaskTools } from "../src/mcp/tools.js";
import type { AgentName, DelegatedTask, StageInput, StageResult } from "../src/types.js";
import type { AgentProvider } from "../src/agents/AgentProvider.js";
import { AgentCoordinator } from "../src/workflow/AgentCoordinator.js";
import { ProjectMemoryStore } from "../src/workflow/ProjectMemory.js";
import { TaskManager } from "../src/workflow/TaskManager.js";
import { TaskStore } from "../src/workflow/TaskStore.js";
import { TeamStore } from "../src/workflow/TeamStore.js";
import { StabilityRunner, StabilityRunStore } from "../src/stability/StabilityRunner.js";

describe("dashboard server", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-store-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-dashboard-workspace-"));
    const runDir = join(workspace, ".agent-runs", "dashboard-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "implement.input.md"), "prompt sent to claude", "utf8");
    await writeFile(join(runDir, "implement.output.md"), "implemented dashboard output", "utf8");
    await writeFile(join(runDir, "claude-implement.log"), "claude debug log", "utf8");
    await new ProjectMemoryStore(workspace).recordTask({
      ...createTask(workspace),
      id: "dashboard-memory-task",
      runId: "dashboard-memory-run",
      request: "Remember dashboard API",
      resultSummary: {
        kind: "task",
        status: "completed",
        stages: ["implement"],
        summary: "Use the dashboard memory panel to inspect learned project context.",
        changedFiles: ["src/dashboard/server.ts"],
        agentSessions: [],
        durationMs: 1000,
        nextSteps: [],
        providerAttempts: ["claude"]
      }
    });

    const store = new TaskStore({ rootDir: root });
    store.save(createTask(workspace));

    server = createDashboardServer({ taskStore: store });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("Unexpected server address"));
        else {
          baseUrl = `http://127.0.0.1:${address.port}`;
          resolve();
        }
      });
    });
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("serves the dashboard shell", async () => {
    const response = await fetch(baseUrl);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Codex Claude Dashboard/);
    assert.match(html, /Command/);
    assert.match(html, /workflow-command/);
    assert.match(html, /workflow-mode-toggle/);
    assert.match(html, /advanced-only/);
    assert.match(html, /providers/);
    assert.match(html, /Auto Dispatch/);
    assert.match(html, /workflow-agent/);
    assert.match(html, /MyFlicker/);
    assert.match(html, /workflow-model/);
    assert.match(html, /Requested model/);
    assert.match(html, /workflow-verify-command/);
    assert.match(html, /workflow-max-repair-attempts/);
    assert.match(html, /quick-start/);
    assert.match(html, /Quick start/);
    assert.match(html, /Understand a project/);
    assert.match(html, /Large multi-agent task/);
    assert.match(html, /stability-panel/);
    assert.match(html, /team-panel/);
    assert.match(html, /Team Mode/);
    assert.match(html, /team-template/);
    assert.match(html, /team-auto-start/);
    assert.match(html, /team-auto-merge/);
    assert.match(html, /team-round-topic/);
    assert.match(html, /team-round-live-agents/);
    assert.match(html, /team-round-create-tasks/);
    assert.match(html, /team-round-submit/);
    assert.match(html, /team-selected-summary/);
    assert.match(html, /show-child-tasks/);
    assert.match(html, /Show child tasks/);
  });

  it("serves Live I/O dashboard code", async () => {
    const response = await fetch(`${baseUrl}/dashboard.js`);
    const js = await response.text();

    assert.equal(response.status, 200);
    assert.match(js, /Result summary/);
    assert.match(js, /renderResultSummaryPanel/);
    assert.match(js, /renderRuntimePanel/);
    assert.match(js, /renderTaskRuntimeLine/);
    assert.match(js, /Output bytes/);
    assert.match(js, /Rollback task/);
    assert.match(js, /renderDiffPanel/);
    assert.match(js, /Live I\/O/);
    assert.match(js, /\/api\/commands/);
    assert.match(js, /\/api\/providers/);
    assert.match(js, /Provider health/);
    assert.match(js, /model status/);
    assert.match(js, /modelError/);
    assert.match(js, /Language servers/);
    assert.match(js, /language-server-summary/);
    assert.match(js, /\/api\/run-command/);
    assert.match(js, /SIMPLE_COMMANDS/);
    assert.match(js, /setMode\("simple"\)/);
    assert.match(js, /body\.dataset\.mode/);
    assert.match(js, /data-io-tab/);
    assert.match(js, /Agents/);
    assert.match(js, /defaultStages/);
    assert.match(js, /Final report/);
    assert.match(js, /Workflow map/);
    assert.match(js, /Requirement progress/);
    assert.match(js, /Plan units/);
    assert.match(js, /Technical details/);
    assert.match(js, /renderRequirementProgressPanel/);
    assert.match(js, /renderPlanUnitsPanel/);
    assert.match(js, /buildExecutionUnits/);
    assert.match(js, /Review findings/);
    assert.match(js, /Changed files/);
    assert.match(js, /renderOutcomePanel/);
    assert.match(js, /deliveryReport/);
    assert.match(js, /renderWorkflowMap/);
    assert.match(js, /renderVerificationPanel/);
    assert.match(js, /Guardrails/);
    assert.match(js, /renderGuardrailsPanel/);
    assert.match(js, /Quality assessment/);
    assert.match(js, /renderQualityPanel/);
    assert.match(js, /loadTaskPreview/);
    assert.match(js, /renderTaskPreview/);
    assert.match(js, /Apply recommended setup/);
    assert.match(js, /applyRecommendedSetup/);
    assert.match(js, /QUICK_START_EXAMPLES/);
    assert.match(js, /applyQuickStart/);
    assert.match(js, /setWorkflowCommand/);
    assert.match(js, /Template applied\. Fill workspace/);
    assert.match(js, /\/api\/task-preview/);
    assert.match(js, /verifyCommand/);
    assert.match(js, /\/api\/stability-runs/);
    assert.match(js, /showChildren/);
    assert.match(js, /visibleTasks/);
    assert.match(js, /Project memory/);
    assert.match(js, /renderProjectMemoryPanel/);
    assert.match(js, /\/api\/project-memory/);
    assert.match(js, /\/api\/teams/);
    assert.match(js, /renderTeamDetail/);
    assert.match(js, /submitTeamMessage/);
    assert.match(js, /submitTeamTask/);
    assert.match(js, /startTeamTask/);
    assert.match(js, /Start agent/);
    assert.match(js, /loadTeamTemplates/);
    assert.match(js, /runTeamCoordinator/);
    assert.match(js, /Run coordinator/);
    assert.match(js, /runTeamRound/);
    assert.match(js, /Run team round/);
    assert.match(js, /renderTeamRoundSelection/);
    assert.match(js, /Select a team first/);
    assert.match(js, /liveAgents/);
    assert.match(js, /createTasks/);
  });

  it("serves dashboard code that preserves task detail scroll during auto-refresh", async () => {
    const response = await fetch(`${baseUrl}/dashboard.js`);
    const js = await response.text();

    assert.equal(response.status, 200);
    assert.match(js, /captureDetailViewState/);
    assert.match(js, /restoreDetailViewState/);
    assert.match(js, /scrollTop/);
    assert.match(js, /openDetails/);
  });

  it("serves non-overlapping workflow step layout assets", async () => {
    const [cssResponse, jsResponse] = await Promise.all([
      fetch(`${baseUrl}/dashboard.css`),
      fetch(`${baseUrl}/dashboard.js`)
    ]);
    const css = await cssResponse.text();
    const js = await jsResponse.text();

    assert.equal(cssResponse.status, 200);
    assert.equal(jsResponse.status, 200);
    assert.match(css, /\.workflow-steps/);
    assert.match(css, /grid-template-columns:\s*88px minmax\(120px, 260px\) minmax\(0, 1fr\)/);
    assert.match(js, /workflow-step-status/);
    assert.match(js, /workflow-step-body/);
  });

  it("lists persisted tasks", async () => {
    const response = await fetch(`${baseUrl}/api/tasks`);
    const data = await response.json() as { ok?: boolean; summary?: { total?: number }; tasks?: Array<{ id?: string }> };

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.summary?.total, 1);
    assert.equal(data.tasks?.[0]?.id, "dashboard-task");
  });

  it("returns project memory for a workspace", async () => {
    const taskResponse = await fetch(`${baseUrl}/api/tasks/dashboard-task`);
    const taskData = await taskResponse.json() as { task?: { workspace?: string } };
    const response = await fetch(`${baseUrl}/api/project-memory?workspace=${encodeURIComponent(taskData.task?.workspace ?? "")}`);
    const data = await response.json() as {
      ok?: boolean;
      markdown?: string;
      entries?: Array<{ taskId?: string; summary?: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.match(data.markdown ?? "", /# Project memory/);
    assert.equal(data.entries?.[0]?.taskId, "dashboard-memory-task");
    assert.match(data.entries?.[0]?.summary ?? "", /memory panel/);
  });

  it("returns task detail with background output", async () => {
    const response = await fetch(`${baseUrl}/api/tasks/dashboard-task`);
    const data = await response.json() as {
      ok?: boolean;
      task?: {
        resultSummary?: { status?: string; changedFiles?: string[]; nextSteps?: string[] };
        rollback?: { status?: string };
      };
      output?: { artifacts?: Array<{ content?: string }>; deliveryReport?: { markdown?: string; statusLabel?: string } };
    };

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.task?.resultSummary?.status, "completed");
    assert.deepEqual(data.task?.resultSummary?.changedFiles, ["index.html"]);
    assert.ok(data.task?.resultSummary?.nextSteps?.some(step => /changed files/i.test(step)));
    assert.equal(data.task?.rollback?.status, "ready");
    assert.equal(data.output?.deliveryReport?.statusLabel, "completed");
    assert.match(data.output?.deliveryReport?.markdown ?? "", /# Delivery report/);
    assert.match(data.output?.deliveryReport?.markdown ?? "", /index\.html/);
    assert.match(data.output?.deliveryReport?.markdown ?? "", /Provider attempts/);
    const artifacts = (data.output?.artifacts ?? []).map(artifact => artifact.content ?? "").join("\n");
    assert.match(artifacts, /prompt sent to claude/);
    assert.match(artifacts, /implemented dashboard output/);
    assert.match(artifacts, /claude debug log/);
  });

  it("reports live runtime for running tasks with growing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-runtime-store-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-dashboard-runtime-workspace-"));
    const runDir = join(workspace, ".agent-runs", "runtime-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "myflicker-implement.stdout.log"), "stream event one\nstream event two\n", "utf8");

    const store = new TaskStore({ rootDir: root });
    store.save({
      id: "runtime-task",
      mode: "background",
      status: "running",
      workspace,
      request: "Long running task",
      stages: ["implement"],
      preferredAgent: "myflicker",
      runId: "runtime-run",
      createdAt: new Date(Date.now() - 90_000).toISOString(),
      updatedAt: new Date(Date.now() - 90_000).toISOString()
    });
    const runtimeServer = createDashboardServer({ taskStore: store });
    const runtimeBaseUrl = await listenTestServer(runtimeServer);
    try {
      const listResponse = await fetch(`${runtimeBaseUrl}/api/tasks`);
      const list = await listResponse.json() as { tasks?: Array<{ id?: string; runtime?: { outputBytes?: number; durationMs?: number }; durationMs?: number }> };
      const listed = list.tasks?.find(task => task.id === "runtime-task");
      assert.ok(listed?.runtime?.outputBytes && listed.runtime.outputBytes > 0);
      assert.ok((listed?.runtime?.durationMs ?? 0) >= 80_000);
      assert.ok((listed?.durationMs ?? 0) >= 80_000);

      const detailResponse = await fetch(`${runtimeBaseUrl}/api/tasks/runtime-task`);
      const detail = await detailResponse.json() as {
        ok?: boolean;
        task?: {
          runtime?: { outputBytes?: number; outputFiles?: Array<{ path?: string }> };
          resultSummary?: { durationMs?: number; summary?: string };
        };
      };
      assert.equal(detail.ok, true);
      assert.ok((detail.task?.runtime?.outputBytes ?? 0) > 0);
      assert.ok(detail.task?.runtime?.outputFiles?.some(file => file.path?.endsWith("myflicker-implement.stdout.log")));
      assert.ok((detail.task?.resultSummary?.durationMs ?? 0) >= 80_000);
      assert.match(detail.task?.resultSummary?.summary ?? "", /Task is running/);
    } finally {
      await new Promise<void>(resolve => runtimeServer.close(() => resolve()));
    }
  });

  it("returns related child tasks for workflow details", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-workflow-store-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-dashboard-workflow-workspace-"));
    const store = new TaskStore({ rootDir: root });
    store.save({
      id: "workflow-parent",
      kind: "workflow",
      mode: "background",
      status: "completed",
      workspace,
      request: "Build workflow",
      stages: [],
      runId: "workflow-parent",
      childTaskIds: ["workflow-child", "workflow-review"],
      reviewTaskId: "workflow-review",
      workflow: { kind: "ultrawork", summary: { total: 2, completed: 2, failed: 0, running: 0, pending: 0 } },
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:01.000Z"
    });
    store.save({
      id: "workflow-child",
      mode: "background",
      status: "completed",
      workspace,
      request: "Implement child",
      stages: ["implement"],
      parentTaskId: "workflow-parent",
      profile: "multi-coder",
      runId: "workflow-child",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:01.000Z"
    });
    store.save({
      id: "workflow-review",
      mode: "background",
      status: "completed",
      workspace,
      request: "Review child",
      stages: ["review"],
      parentTaskId: "workflow-parent",
      profile: "momus",
      runId: "workflow-review",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:01.000Z"
    });
    const workflowServer = createDashboardServer({ taskStore: store });
    const workflowBaseUrl = await listenTestServer(workflowServer);
    try {
      const response = await fetch(`${workflowBaseUrl}/api/tasks/workflow-parent`);
      const data = await response.json() as { ok?: boolean; relatedTasks?: Array<{ id?: string; status?: string; profile?: string }> };

      assert.equal(response.status, 200);
      assert.equal(data.ok, true);
      assert.deepEqual(data.relatedTasks?.map(task => task.id), ["workflow-child", "workflow-review"]);
      assert.equal(data.relatedTasks?.[1]?.profile, "momus");
    } finally {
      await new Promise<void>(resolve => workflowServer.close(() => resolve()));
    }
  });

  it("cancels live tasks when attached to a TaskManager", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-live-store-"));
    const store = new TaskStore({ rootDir: root });
    const manager = new TaskManager(new AgentCoordinator({
      providers: {
        claude: new SlowProvider("claude"),
        codex: new SlowProvider("codex")
      }
    }), store);
    const launched = await manager.run({
      mode: "background",
      workspace: "/tmp/project",
      request: "Long task",
      stages: ["implement"],
      routing: {},
      preferredAgent: "claude",
      runId: "dashboard-live-task"
    });
    assert.equal(launched.task?.status, "running");

    const liveServer = createDashboardServer({ taskManager: manager });
    const liveBaseUrl = await listenTestServer(liveServer);
    try {
      const response = await fetch(`${liveBaseUrl}/api/tasks/dashboard-live-task/cancel`, { method: "POST" });
      const data = await response.json() as { ok?: boolean; task?: { status?: string } };

      assert.equal(response.status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.task?.status, "cancelled");
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()));
    }
  });

  it("creates plans and delegated tasks through live dashboard APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-tools-store-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-dashboard-tools-workspace-"));
    const store = new TaskStore({ rootDir: root });
    const claude = {
      claudePath: "claude",
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({ result: "Create index.html" }),
        stderr: "",
        timedOut: false
      }),
      getChangedFiles: async () => []
    };
    const config = {
      skills: {
        "dashboard-skill": {
          content: "Dashboard skill content."
        }
      }
    };
    const manager = createTaskManager({ taskStore: store, claude, config });
    const tools = createTaskTools({
      taskManager: manager,
      claude,
      config
    });
    const liveServer = createDashboardServer({ taskManager: manager, taskTools: tools });
    const liveBaseUrl = await listenTestServer(liveServer);
    try {
      const planResponse = await fetch(`${liveBaseUrl}/api/create-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace, request: "Build hello", planId: "dashboard-plan" })
      });
      const plan = await planResponse.json() as { ok?: boolean; planId?: string; planPath?: string };
      assert.equal(planResponse.status, 200);
      assert.equal(plan.ok, true);
      assert.equal(plan.planId, "dashboard-plan");

      const taskResponse = await fetch(`${liveBaseUrl}/api/delegate-task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace,
          request: "Build hello",
          mode: "background",
          stage: "implement",
          preferredAgent: "claude",
          runId: "dashboard-created-task",
          model: "claude-dashboard-model",
          effort: "high",
          timeoutMs: 12345,
          verifyCommand: `${process.execPath} -e "process.exit(0)"`,
          maxRepairAttempts: 0,
          loadSkills: ["dashboard-skill"]
        })
      });
      const task = await taskResponse.json() as { ok?: boolean; taskId?: string };
      assert.equal(taskResponse.status, 200);
      assert.equal(task.ok, true);
      assert.equal(task.taskId, "dashboard-created-task");

      const statusResponse = await fetch(`${liveBaseUrl}/api/tasks/dashboard-created-task`);
      const status = await statusResponse.json() as {
        ok?: boolean;
        task?: {
          model?: string;
          effort?: string;
          timeoutMs?: number;
          verifyCommand?: string;
          maxRepairAttempts?: number;
          skills?: Array<{ name?: string }>;
        };
      };
      assert.equal(status.ok, true);
      assert.equal(status.task?.model, "claude-dashboard-model");
      assert.equal(status.task?.effort, "high");
      assert.equal(status.task?.timeoutMs, 12345);
      assert.equal(status.task?.verifyCommand, `${process.execPath} -e "process.exit(0)"`);
      assert.equal(status.task?.maxRepairAttempts, 0);
      assert.deepEqual(status.task?.skills?.map(skill => skill.name), ["dashboard-skill"]);

      const autoResponse = await fetch(`${liveBaseUrl}/api/auto-dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace,
          request: "Build hello with natural language",
          mode: "background",
          strategy: "direct",
          preferredAgent: "claude",
          runId: "dashboard-auto-task"
        })
      });
      const auto = await autoResponse.json() as { ok?: boolean; strategy?: string; taskId?: string };
      assert.equal(autoResponse.status, 200);
      assert.equal(auto.ok, true);
      assert.equal(auto.strategy, "direct");
      assert.equal(auto.taskId, "dashboard-auto-task");
      const autoStatusResponse = await fetch(`${liveBaseUrl}/api/tasks/dashboard-auto-task`);
      const autoStatus = await autoStatusResponse.json() as { task?: { preferredAgent?: string; profile?: string } };
      assert.equal(autoStatus.task?.preferredAgent, "claude");
      assert.equal(autoStatus.task?.profile, undefined);

      const commandsResponse = await fetch(`${liveBaseUrl}/api/commands`);
      const commands = await commandsResponse.json() as { ok?: boolean; commands?: Array<{ name?: string }> };
      assert.equal(commands.ok, true);
      assert.ok(commands.commands?.some(command => command.name === "start-work"));

      const providersResponse = await fetch(`${liveBaseUrl}/api/providers`);
      const providers = await providersResponse.json() as { checks?: Array<{ provider?: string; status?: string }>; languageServers?: Array<{ language?: string; status?: string }> };
      assert.ok(providers.checks?.some(check => check.provider === "claude"));
      assert.ok(providers.languageServers?.some(check => check.language === "python"));

      const commandResponse = await fetch(`${liveBaseUrl}/api/run-command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace,
          command: "/start-work Build from command",
          preferredAgent: "claude",
          runId: "dashboard-command-task"
        })
      });
      const command = await commandResponse.json() as { ok?: boolean; command?: string; taskId?: string };
      assert.equal(commandResponse.status, 200);
      assert.equal(command.ok, true);
      assert.equal(command.command, "start-work");
      assert.equal(command.taskId, "dashboard-command-task");
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()));
    }
  });

  it("retries tasks through the live dashboard API", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-retry-store-"));
    const store = new TaskStore({ rootDir: root });
    store.save({
      id: "dashboard-retry-source",
      mode: "background",
      status: "failed",
      workspace: "/tmp/project",
      request: "Retry me",
      stages: ["implement"],
      preferredAgent: "claude",
      runId: "dashboard-retry-source",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:01.000Z"
    });
    const manager = new TaskManager(new AgentCoordinator({
      providers: {
        claude: new SlowProvider("claude"),
        codex: new SlowProvider("codex")
      }
    }), store);
    const tools = createTaskTools({ taskManager: manager });
    const liveServer = createDashboardServer({ taskManager: manager, taskTools: tools });
    const liveBaseUrl = await listenTestServer(liveServer);
    try {
      const response = await fetch(`${liveBaseUrl}/api/tasks/dashboard-retry-source/retry`, { method: "POST" });
      const data = await response.json() as { ok?: boolean; task?: { retryOf?: string }; taskId?: string };

      assert.equal(response.status, 200);
      assert.equal(data.ok, true);
      assert.ok(data.taskId);
      assert.equal(data.task?.retryOf, "dashboard-retry-source");
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()));
    }
  });

  it("manages Team Mode through the live dashboard API", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-team-store-"));
    const tools = createTaskTools({ teamStore: new TeamStore({ rootDir: join(root, "teams") }) });
    const liveServer = createDashboardServer({ taskTools: tools });
    const liveBaseUrl = await listenTestServer(liveServer);
    try {
      const createResponse = await fetch(`${liveBaseUrl}/api/teams`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId: "dashboard-team",
          workspace: "/tmp/project",
          goal: "Coordinate a bug fix",
          lead: "lead",
          members: [
            { id: "planner", role: "planning", agent: "claude" },
            { id: "coder", role: "implementation", agent: "codex-cli" }
          ]
        })
      });
      const created = await createResponse.json() as { ok?: boolean; team?: { id?: string } };
      assert.equal(createResponse.status, 200);
      assert.equal(created.ok, true);
      assert.equal(created.team?.id, "dashboard-team");

      const messageResponse = await fetch(`${liveBaseUrl}/api/teams/dashboard-team/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "planner", to: "coder", body: "Please implement the planned fix." })
      });
      const message = await messageResponse.json() as { ok?: boolean; message?: { body?: string } };
      assert.equal(messageResponse.status, 200);
      assert.equal(message.ok, true);
      assert.match(message.message?.body ?? "", /planned fix/);

      const taskResponse = await fetch(`${liveBaseUrl}/api/teams/dashboard-team/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Implement fix", assignee: "coder" })
      });
      const task = await taskResponse.json() as { ok?: boolean; task?: { id?: string } };
      assert.equal(taskResponse.status, 200);
      assert.equal(task.ok, true);
      assert.equal(task.task?.id, "dashboard-team-task-1");

      const updateResponse = await fetch(`${liveBaseUrl}/api/teams/dashboard-team/tasks/dashboard-team-task-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "in_progress", linkedTaskId: "delegate-dashboard" })
      });
      const updated = await updateResponse.json() as { ok?: boolean; task?: { status?: string; linkedTaskId?: string } };
      assert.equal(updateResponse.status, 200);
      assert.equal(updated.ok, true);
      assert.equal(updated.task?.status, "in_progress");
      assert.equal(updated.task?.linkedTaskId, "delegate-dashboard");

      const listResponse = await fetch(`${liveBaseUrl}/api/teams`);
      const list = await listResponse.json() as { ok?: boolean; teams?: Array<{ id?: string; messages?: unknown[]; tasks?: unknown[] }> };
      assert.equal(list.ok, true);
      assert.equal(list.teams?.[0]?.id, "dashboard-team");
      assert.equal(list.teams?.[0]?.messages?.length, 1);
      assert.equal(list.teams?.[0]?.tasks?.length, 1);
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()));
    }
  });

  it("creates Team Mode templates and runs the coordinator through the dashboard API", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-team-template-"));
    const manager = createTaskManager({
      taskStore: new TaskStore({ rootDir: join(root, "tasks") }),
      claude: {
        claudePath: "claude",
        exec: async () => ({ code: 0, stdout: JSON.stringify({ result: "template task done" }), stderr: "", timedOut: false }),
        getChangedFiles: async () => []
      }
    });
    const tools = createTaskTools({
      taskManager: manager,
      teamStore: new TeamStore({ rootDir: join(root, "teams") })
    });
    const liveServer = createDashboardServer({ taskManager: manager, taskTools: tools });
    const liveBaseUrl = await listenTestServer(liveServer);
    try {
      const templatesResponse = await fetch(`${liveBaseUrl}/api/team-templates`);
      const templates = await templatesResponse.json() as { ok?: boolean; templates?: Array<{ name?: string }> };
      assert.equal(templates.ok, true);
      assert.ok(templates.templates?.some(template => template.name === "frontend-team"));

      const createResponse = await fetch(`${liveBaseUrl}/api/teams/from-template`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId: "dashboard-template-team",
          template: "bugfix-team",
          workspace: "/tmp/project",
          goal: "Fix dashboard template bug",
          autoStart: false
        })
      });
      const created = await createResponse.json() as { ok?: boolean; team?: { tasks?: unknown[]; coordinator?: { phase?: string } } };
      assert.equal(createResponse.status, 200);
      assert.equal(created.ok, true);
      assert.equal(created.team?.tasks?.length, 3);
      assert.equal(created.team?.coordinator?.phase, "idle");

      const coordinatorResponse = await fetch(`${liveBaseUrl}/api/teams/dashboard-template-team/coordinator-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoStart: true, autoMerge: true, maxStarts: 1 })
      });
      const coordinated = await coordinatorResponse.json() as { ok?: boolean; startedTaskIds?: string[]; team?: { coordinator?: { phase?: string } } };
      assert.equal(coordinatorResponse.status, 200);
      assert.equal(coordinated.ok, true);
      assert.equal(coordinated.startedTaskIds?.length, 1);
      assert.equal(coordinated.team?.coordinator?.phase, "running");
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()));
    }
  });

  it("starts Team Mode tasks through the live dashboard API", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-team-start-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-dashboard-team-start-workspace-"));
    const store = new TaskStore({ rootDir: join(root, "tasks") });
    const manager = createTaskManager({
      taskStore: store,
      claude: {
        claudePath: "claude",
        exec: async () => ({ code: 0, stdout: JSON.stringify({ result: "team task done" }), stderr: "", timedOut: false }),
        getChangedFiles: async () => []
      }
    });
    const tools = createTaskTools({
      taskManager: manager,
      teamStore: new TeamStore({ rootDir: join(root, "teams") })
    });
    const liveServer = createDashboardServer({ taskManager: manager, taskTools: tools });
    const liveBaseUrl = await listenTestServer(liveServer);
    try {
      await fetch(`${liveBaseUrl}/api/teams`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId: "dashboard-start-team",
          workspace,
          goal: "Start a real delegated task",
          members: [{ id: "coder", role: "implementation", agent: "claude" }]
        })
      });
      await fetch(`${liveBaseUrl}/api/teams/dashboard-start-team/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Implement linked task", assignee: "coder" })
      });

      const startResponse = await fetch(`${liveBaseUrl}/api/teams/dashboard-start-team/tasks/dashboard-start-team-task-1/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "background" })
      });
      const started = await startResponse.json() as { ok?: boolean; delegatedTaskId?: string; teamTask?: { linkedTaskId?: string; status?: string } };
      assert.equal(startResponse.status, 200);
      assert.equal(started.ok, true);
      assert.ok(started.delegatedTaskId);
      assert.equal(started.teamTask?.linkedTaskId, started.delegatedTaskId);
      assert.equal(started.teamTask?.status, "in_progress");

      const taskResponse = await fetch(`${liveBaseUrl}/api/tasks/${started.delegatedTaskId}`);
      const delegated = await taskResponse.json() as { ok?: boolean; task?: { request?: string; preferredAgent?: string } };
      assert.equal(delegated.ok, true);
      assert.match(delegated.task?.request ?? "", /Execute the assigned Team Mode task only/);
      assert.equal(delegated.task?.preferredAgent, "claude");

      const teamResponse = await fetch(`${liveBaseUrl}/api/teams/dashboard-start-team`);
      const team = await teamResponse.json() as { ok?: boolean; linkedTasks?: Array<{ id?: string; status?: string }> };
      assert.equal(team.ok, true);
      assert.equal(team.linkedTasks?.[0]?.id, started.delegatedTaskId);
      assert.ok(team.linkedTasks?.[0]?.status);
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()));
    }
  });

  it("runs Team Mode communication rounds through the live dashboard API", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-team-round-"));
    const tools = createTaskTools({ teamStore: new TeamStore({ rootDir: join(root, "teams") }) });
    const liveServer = createDashboardServer({ taskTools: tools });
    const liveBaseUrl = await listenTestServer(liveServer);
    try {
      await fetch(`${liveBaseUrl}/api/teams`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId: "dashboard-round-team",
          workspace: "/tmp/project",
          goal: "Coordinate a feature",
          members: [
            { id: "planner", role: "planning", agent: "codex-cli" },
            { id: "coder", role: "implementation", agent: "claude" },
            { id: "reviewer", role: "review", agent: "codex-cli" }
          ]
        })
      });

      const roundResponse = await fetch(`${liveBaseUrl}/api/teams/dashboard-round-team/round-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "Align on plan, risks, and next action", createTasks: true, maxGeneratedTasks: 1 })
      });
      const round = await roundResponse.json() as {
        ok?: boolean;
        round?: { participantCount?: number; messages?: Array<{ from?: string; body?: string }>; generatedTasks?: unknown[] };
        team?: { messages?: unknown[]; tasks?: unknown[]; coordinator?: { phase?: string } };
      };

      assert.equal(roundResponse.status, 200);
      assert.equal(round.ok, true);
      assert.equal(round.round?.participantCount, 3);
      assert.equal(round.round?.messages?.length, 3);
      assert.equal(round.round?.generatedTasks?.length, 1);
      assert.equal(round.team?.messages?.length, 3);
      assert.equal(round.team?.tasks?.length, 1);
      assert.equal(round.team?.coordinator?.phase, "running");
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()));
    }
  });

  it("runs Team Mode autonomy loops through the live dashboard API", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-team-autonomy-"));
    const manager = new TaskManager(new AgentCoordinator({
      providers: {
        claude: new FastProvider("claude"),
        "codex-cli": new FastProvider("codex-cli")
      }
    }), new TaskStore({ rootDir: join(root, "tasks") }));
    const tools = createTaskTools({
      taskManager: manager,
      teamStore: new TeamStore({ rootDir: join(root, "teams") })
    });
    const liveServer = createDashboardServer({ taskManager: manager, taskTools: tools });
    const liveBaseUrl = await listenTestServer(liveServer);
    try {
      await fetch(`${liveBaseUrl}/api/teams`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId: "dashboard-autonomy-team",
          workspace: "/tmp/project",
          goal: "Autonomously coordinate a feature",
          members: [
            { id: "planner", role: "planning", agent: "codex-cli" },
            { id: "coder", role: "implementation", agent: "claude" }
          ]
        })
      });

      const response = await fetch(`${liveBaseUrl}/api/teams/dashboard-autonomy-team/autonomy-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cycles: 2, liveAgents: true, createTasks: false, autoStart: true })
      });
      const data = await response.json() as {
        ok?: boolean;
        cycles?: Array<{ roundId?: string; phase?: string }>;
        team?: { memory?: unknown[]; members?: Array<{ id?: string; memory?: unknown[] }> };
      };

      assert.equal(response.status, 200);
      assert.equal(data.ok, true);
      assert.ok((data.cycles?.length ?? 0) >= 1);
      assert.ok((data.team?.memory?.length ?? 0) > 0);
      assert.ok(data.team?.members?.some(member => member.id === "planner" && (member.memory?.length ?? 0) > 0));
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()));
    }
  });

  it("starts and reports stability runs through the live dashboard API", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-stability-store-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "bridge-dashboard-stability-workspaces-"));
    const manager = new TaskManager(new AgentCoordinator({
      providers: {
        claude: new SlowProvider("claude"),
        "codex-cli": new SlowProvider("codex-cli")
      }
    }), new TaskStore({ rootDir: join(root, "tasks") }));
    const stabilityRunner = new StabilityRunner({
      taskManager: manager,
      store: new StabilityRunStore({ rootDir: join(root, "stability") })
    });
    const liveServer = createDashboardServer({ taskManager: manager, stabilityRunner });
    const liveBaseUrl = await listenTestServer(liveServer);
    try {
      const createResponse = await fetch(`${liveBaseUrl}/api/stability-runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceRoot,
          request: "Create a small file.",
          providers: ["claude", "codex-cli"],
          iterations: 1
        })
      });
      const created = await createResponse.json() as { ok?: boolean; runId?: string; run?: { tasks?: unknown[] } };
      assert.equal(createResponse.status, 200);
      assert.equal(created.ok, true);
      assert.equal(created.run?.tasks?.length, 2);

      await waitFor(async () => {
        const detailResponse = await fetch(`${liveBaseUrl}/api/stability-runs/${created.runId}`);
        const detail = await detailResponse.json() as { run?: { status?: string } };
        return detail.run?.status === "completed";
      });

      const listResponse = await fetch(`${liveBaseUrl}/api/stability-runs`);
      const list = await listResponse.json() as { ok?: boolean; runs?: Array<{ id?: string; summary?: { completed?: number } }> };
      assert.equal(list.ok, true);
      assert.equal(list.runs?.[0]?.id, created.runId);
      assert.equal(list.runs?.[0]?.summary?.completed, 2);
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()));
    }
  });
});

function createTask(workspace: string): DelegatedTask {
  return {
    id: "dashboard-task",
    mode: "background",
    status: "completed",
    workspace,
    request: "Implement dashboard",
    stages: ["implement"],
    profile: "coder",
    preferredAgent: "claude",
    runId: "dashboard-run",
    createdAt: "2026-05-19T10:00:00.000Z",
    updatedAt: "2026-05-19T10:00:01.000Z",
    result: {
      ok: true,
      results: [
        {
          ok: true,
          runId: "dashboard-run",
          stage: "implement",
          agent: "claude",
          status: "completed",
          changedFiles: ["index.html"],
          requiresCodex: false,
          summary: "done"
        }
      ]
    },
    gitCheckpoint: {
      supported: true,
      clean: true,
      head: "abc123",
      createdAt: "2026-05-19T10:00:00.000Z"
    },
    gitDiff: {
      supported: true,
      files: [{ path: "index.html", status: "modified" }],
      patch: "diff --git a/index.html b/index.html\n+hello",
      generatedAt: "2026-05-19T10:00:01.000Z"
    }
  };
}

class SlowProvider implements AgentProvider {
  constructor(readonly name: AgentName) {}

  async run(input: StageInput): Promise<StageResult> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      input.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
    return {
      ok: true,
      runId: input.runId ?? "dashboard-live-task",
      stage: input.stage,
      agent: this.name,
      status: "completed",
      changedFiles: [],
      requiresCodex: false,
      summary: "done"
    };
  }
}

class FastProvider implements AgentProvider {
  constructor(readonly name: AgentName) {}

  async run(input: StageInput): Promise<StageResult> {
    const member = /Your member id: ([^\n]+)/.exec(input.request)?.[1] ?? this.name;
    return {
      ok: true,
      runId: input.runId ?? "dashboard-fast-task",
      stage: input.stage,
      agent: this.name,
      status: "completed",
      changedFiles: [],
      requiresCodex: false,
      summary: `agent response for ${member}`
    };
  }
}

async function listenTestServer(server: Server): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Unexpected server address"));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
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
