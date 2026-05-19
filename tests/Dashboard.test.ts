import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createDashboardServer } from "../src/dashboard/server.js";
import type { DelegatedTask } from "../src/types.js";
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
