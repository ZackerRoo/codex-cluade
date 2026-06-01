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
import { TaskManager } from "../src/workflow/TaskManager.js";
import { TaskStore } from "../src/workflow/TaskStore.js";
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
    assert.match(html, /workflow-model/);
    assert.match(html, /Requested model/);
    assert.match(html, /workflow-verify-command/);
    assert.match(html, /workflow-max-repair-attempts/);
    assert.match(html, /stability-panel/);
  });

  it("serves Live I/O dashboard code", async () => {
    const response = await fetch(`${baseUrl}/dashboard.js`);
    const js = await response.text();

    assert.equal(response.status, 200);
    assert.match(js, /Live I\/O/);
    assert.match(js, /\/api\/commands/);
    assert.match(js, /\/api\/providers/);
    assert.match(js, /Provider health/);
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
    assert.match(js, /Review findings/);
    assert.match(js, /Changed files/);
    assert.match(js, /renderOutcomePanel/);
    assert.match(js, /renderWorkflowMap/);
    assert.match(js, /renderVerificationPanel/);
    assert.match(js, /verifyCommand/);
    assert.match(js, /\/api\/stability-runs/);
  });

  it("lists persisted tasks", async () => {
    const response = await fetch(`${baseUrl}/api/tasks`);
    const data = await response.json() as { ok?: boolean; summary?: { total?: number }; tasks?: Array<{ id?: string }> };

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.summary?.total, 1);
    assert.equal(data.tasks?.[0]?.id, "dashboard-task");
  });

  it("returns task detail with background output", async () => {
    const response = await fetch(`${baseUrl}/api/tasks/dashboard-task`);
    const data = await response.json() as { ok?: boolean; output?: { artifacts?: Array<{ content?: string }> } };

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    const artifacts = (data.output?.artifacts ?? []).map(artifact => artifact.content ?? "").join("\n");
    assert.match(artifacts, /prompt sent to claude/);
    assert.match(artifacts, /implemented dashboard output/);
    assert.match(artifacts, /claude debug log/);
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
          changedFiles: [],
          requiresCodex: false,
          summary: "done"
        }
      ]
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
