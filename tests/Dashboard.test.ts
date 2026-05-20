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

describe("dashboard server", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-dashboard-store-"));
    const workspace = await mkdtemp(join(tmpdir(), "bridge-dashboard-workspace-"));
    const runDir = join(workspace, ".agent-runs", "dashboard-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "implement.output.md"), "implemented dashboard output", "utf8");

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
    assert.match(data.output?.artifacts?.[0]?.content ?? "", /implemented dashboard output/);
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
    const manager = createTaskManager({ taskStore: store, claude });
    const tools = createTaskTools({
      taskManager: manager,
      claude
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
        body: JSON.stringify({ workspace, request: "Build hello", mode: "background", stage: "implement", preferredAgent: "claude", runId: "dashboard-created-task" })
      });
      const task = await taskResponse.json() as { ok?: boolean; taskId?: string };
      assert.equal(taskResponse.status, 200);
      assert.equal(task.ok, true);
      assert.equal(task.taskId, "dashboard-created-task");
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
