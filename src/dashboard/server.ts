import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { readBackgroundOutput } from "../mcp/backgroundOutput.js";
import type { CreatePlanArgs, DelegateTaskArgs, ExecutePlanArgs, TaskToolSet } from "../mcp/tools.js";
import type { DelegatedTask, TaskStatus } from "../types.js";
import type { TaskManager } from "../workflow/TaskManager.js";
import { TaskStore } from "../workflow/TaskStore.js";

export interface DashboardOptions {
  host?: string;
  port?: number;
  taskStore?: TaskStore;
  taskManager?: TaskManager;
  taskTools?: TaskToolSet;
  maxBytes?: number;
}

export interface DashboardListener {
  server: Server;
  url: string;
}

export function createDashboardServer(options: DashboardOptions = {}): Server {
  const taskStore = options.taskStore ?? new TaskStore();
  const taskManager = options.taskManager;
  const taskTools = options.taskTools;
  const maxBytes = options.maxBytes ?? 24_000;

  return createServer(async (request, response) => {
    try {
      await routeRequest(request, response, { taskStore, taskManager, taskTools, maxBytes });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

export async function listenDashboard(options: DashboardOptions = {}): Promise<DashboardListener> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  const server = createDashboardServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? (address as AddressInfo).port : port;
  return { server, url: `http://${host}:${actualPort}` };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: { taskStore: TaskStore; taskManager?: TaskManager; taskTools?: TaskToolSet; maxBytes: number }
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method !== "GET" && request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, DASHBOARD_HTML);
    return;
  }
  if (request.method === "GET" && url.pathname === "/dashboard.css") {
    sendText(response, 200, "text/css; charset=utf-8", DASHBOARD_CSS);
    return;
  }
  if (request.method === "GET" && url.pathname === "/dashboard.js") {
    sendText(response, 200, "text/javascript; charset=utf-8", DASHBOARD_JS);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const tasks = listTasks(context);
    sendJson(response, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: summarizeTasks(tasks),
      tasks: tasks.map(taskListItem)
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/capabilities") {
    sendJson(response, 200, {
      ok: true,
      liveTaskManager: Boolean(context.taskManager),
      liveTaskTools: Boolean(context.taskTools)
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/delegate-task") {
    if (!context.taskTools) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to live task tools." });
      return;
    }
    const result = await context.taskTools.delegateTaskTool(await readJsonBody(request) as unknown as DelegateTaskArgs);
    sendToolResult(response, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/create-plan") {
    if (!context.taskTools) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to live task tools." });
      return;
    }
    const result = await context.taskTools.createPlanTool(await readJsonBody(request) as unknown as CreatePlanArgs);
    sendToolResult(response, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/execute-plan") {
    if (!context.taskTools) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to live task tools." });
      return;
    }
    const result = await context.taskTools.executePlanTool(await readJsonBody(request) as unknown as ExecutePlanArgs);
    sendToolResult(response, result);
    return;
  }
  if (url.pathname.startsWith("/api/tasks/")) {
    const parts = url.pathname.slice("/api/tasks/".length).split("/");
    const taskId = decodeURIComponent(parts[0] ?? "");
    if (request.method === "POST" && parts[1] === "cancel") {
      if (!context.taskManager) {
        sendJson(response, 409, { ok: false, error: "Dashboard is not attached to a live TaskManager." });
        return;
      }
      const task = context.taskManager.cancel(taskId);
      if (!task) {
        sendJson(response, 404, { ok: false, error: `Task not found: ${taskId}` });
        return;
      }
      sendJson(response, 200, { ok: true, task });
      return;
    }
    if (request.method !== "GET" || parts.length !== 1) {
      sendJson(response, 404, { ok: false, error: "Not found" });
      return;
    }
    const task = getTask(context, taskId);
    if (!task) {
      sendJson(response, 404, { ok: false, error: `Task not found: ${taskId}` });
      return;
    }
    const output = await readBackgroundOutput(task, context.maxBytes, Number(url.searchParams.get("cursor") ?? 0));
    sendJson(response, 200, { ok: true, task, output });
    return;
  }

  sendJson(response, 404, { ok: false, error: "Not found" });
}

function listTasks(context: { taskStore: TaskStore; taskManager?: TaskManager }): DelegatedTask[] {
  return context.taskManager ? context.taskManager.list() : context.taskStore.list();
}

function getTask(context: { taskStore: TaskStore; taskManager?: TaskManager }, taskId: string): DelegatedTask | undefined {
  return context.taskManager ? context.taskManager.get(taskId) : context.taskStore.get(taskId);
}

function summarizeTasks(tasks: DelegatedTask[]): Record<TaskStatus, number> & { total: number; runningCapacity?: number } {
  const counts = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    total: tasks.length
  };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}

function taskListItem(task: DelegatedTask): DelegatedTask & { durationMs: number; queuePosition?: number } {
  const created = Date.parse(task.createdAt);
  const updated = Date.parse(task.updatedAt);
  return {
    ...task,
    durationMs: Number.isFinite(created) && Number.isFinite(updated) ? Math.max(0, updated - created) : 0
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function sendToolResult(response: ServerResponse, result: { structuredContent?: unknown; isError?: boolean; content?: unknown }): void {
  sendJson(response, result.isError ? 400 : 200, {
    ok: result.isError ? false : true,
    ...asRecord(result.structuredContent),
    content: result.content
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  sendText(response, statusCode, "application/json; charset=utf-8", JSON.stringify(body, null, 2));
}

function sendHtml(response: ServerResponse, html: string): void {
  sendText(response, 200, "text/html; charset=utf-8", html);
}

function sendText(response: ServerResponse, statusCode: number, contentType: string, content: string): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(content);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Claude Dashboard</title>
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div>
        <h1>Codex Claude Dashboard</h1>
        <p id="updated">Loading task store</p>
      </div>
      <button id="refresh" type="button" title="Refresh tasks">Refresh</button>
    </section>
    <section class="new-task" id="workflow-panel" hidden>
      <div class="tabbar" role="tablist" aria-label="New workflow">
        <button class="tab active" type="button" data-tab="delegate">Delegate Task</button>
        <button class="tab" type="button" data-tab="create-plan">Create Plan</button>
        <button class="tab" type="button" data-tab="execute-plan">Execute Plan</button>
      </div>
      <form id="workflow-form" class="workflow-form">
        <label>Workspace<input id="workflow-workspace" name="workspace" placeholder="/absolute/path/to/project" required></label>
        <label class="request-field">Request<textarea id="workflow-request" name="request" rows="3" placeholder="Describe the work"></textarea></label>
        <div class="form-row" id="delegate-fields">
          <label>Stage<select id="workflow-stage" name="stage"><option value="implement">implement</option><option value="plan">plan</option><option value="review">review</option><option value="analyze">analyze</option></select></label>
          <label>Profile<input id="workflow-profile" name="profile" placeholder="coder"></label>
          <label>Mode<select id="workflow-mode" name="mode"><option value="background">background</option><option value="sync">sync</option></select></label>
        </div>
        <div class="form-row" id="plan-fields" hidden>
          <label>Plan ID<input id="workflow-plan-id" name="planId" placeholder="optional"></label>
          <label>Planner Profile<input id="workflow-planner-profile" name="plannerProfile" placeholder="optional"></label>
        </div>
        <div class="form-row" id="execute-fields" hidden>
          <label>Plan ID<input id="workflow-execute-plan-id" name="executePlanId" placeholder="plan id"></label>
          <label>Plan Path<input id="workflow-plan-path" name="planPath" placeholder="or path"></label>
          <label>Executor Profile<input id="workflow-executor-profile" name="executorProfile" placeholder="coder"></label>
        </div>
        <div class="form-actions">
          <button id="workflow-submit" type="submit">Run</button>
          <span id="workflow-status" class="form-status"></span>
        </div>
      </form>
    </section>
    <section class="metrics" id="metrics"></section>
    <section class="workspace">
      <aside class="task-list" aria-label="Tasks">
        <div class="list-head">
          <h2>Tasks</h2>
          <select id="status-filter" aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="running">Running</option>
            <option value="pending">Pending</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="interrupted">Interrupted</option>
          </select>
        </div>
        <div id="tasks" class="tasks"></div>
      </aside>
      <section class="detail" aria-label="Task detail">
        <div id="detail-empty" class="empty">Select a task to inspect its stage output, Claude session, and transcript summary.</div>
        <div id="detail" hidden></div>
      </section>
    </section>
  </main>
  <script src="/dashboard.js"></script>
</body>
</html>`;

const DASHBOARD_CSS = `:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --line: #d8dee8;
  --text: #18202f;
  --muted: #657287;
  --accent: #0f766e;
  --danger: #b42318;
  --warn: #a15c07;
  --ok: #14743f;
  --radius: 8px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
button, select { font: inherit; }
.shell { min-height: 100vh; padding: 20px; display: grid; grid-template-rows: auto auto 1fr; gap: 16px; }
.topbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
h1, h2, h3, p { margin: 0; }
h1 { font-size: 24px; line-height: 1.2; }
h2 { font-size: 16px; }
h3 { font-size: 14px; margin-bottom: 8px; }
#updated { color: var(--muted); margin-top: 6px; font-size: 13px; }
#refresh { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 6px; padding: 8px 12px; cursor: pointer; }
#refresh:hover { border-color: var(--accent); }
.new-task { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; }
.tabbar { display: flex; gap: 6px; margin-bottom: 12px; }
.tab { border: 1px solid var(--line); background: #fff; border-radius: 6px; padding: 7px 10px; cursor: pointer; }
.tab.active { background: #ccfbf1; border-color: var(--accent); color: #115e59; }
.workflow-form { display: grid; gap: 10px; }
.workflow-form label { display: grid; gap: 5px; min-width: 0; color: var(--muted); font-size: 12px; }
.workflow-form input, .workflow-form textarea, .workflow-form select { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 8px; color: var(--text); background: #fff; }
.workflow-form textarea { resize: vertical; min-height: 72px; }
.request-field { grid-column: 1 / -1; }
.form-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.form-actions { display: flex; align-items: center; gap: 10px; }
#workflow-submit { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 6px; padding: 8px 12px; cursor: pointer; }
.form-status { color: var(--muted); font-size: 13px; }
.metrics { display: grid; grid-template-columns: repeat(7, minmax(92px, 1fr)); gap: 10px; }
.metric { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; min-height: 72px; }
.metric span { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; }
.metric strong { display: block; margin-top: 8px; font-size: 24px; }
.workspace { display: grid; grid-template-columns: minmax(300px, 390px) minmax(0, 1fr); gap: 16px; min-height: 0; min-width: 0; }
.task-list { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); min-height: 0; min-width: 0; }
.task-list { display: grid; grid-template-rows: auto 1fr; overflow: hidden; }
.list-head { padding: 14px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 10px; align-items: center; }
select { border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text); padding: 6px 8px; max-width: 160px; }
.tasks { overflow-y: auto; overflow-x: hidden; }
.task-row { width: 100%; min-width: 0; text-align: left; border: 0; border-bottom: 1px solid var(--line); background: #fff; padding: 12px 14px; cursor: pointer; display: grid; gap: 7px; }
.task-row:hover, .task-row.active { background: #f0fdfa; }
.task-title { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
.task-title strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { font-size: 12px; border-radius: 999px; padding: 3px 8px; background: #eef2f7; color: var(--muted); text-transform: capitalize; }
.status.running { background: #e0f2fe; color: #075985; }
.status.pending { background: #fef3c7; color: var(--warn); }
.status.completed { background: #dcfce7; color: var(--ok); }
.status.failed, .status.interrupted { background: #fee2e2; color: var(--danger); }
.meta { color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.detail { overflow: auto; min-height: 0; min-width: 0; }
.empty { color: var(--muted); height: 100%; display: grid; place-items: center; text-align: center; padding: 28px; }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.panel { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; background: #fff; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
.danger-button { border: 1px solid #fecaca; background: #fff1f2; color: var(--danger); border-radius: 6px; padding: 7px 10px; cursor: pointer; }
.danger-button:hover { border-color: var(--danger); }
.kv { display: grid; grid-template-columns: 120px 1fr; gap: 8px; font-size: 13px; margin-top: 6px; }
.kv span:first-child { color: var(--muted); }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #101828; color: #f8fafc; border-radius: 6px; padding: 12px; max-height: 360px; overflow: auto; }
.section { margin-top: 14px; }
.pill-line { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.pill { border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
@media (max-width: 900px) {
  .shell { padding: 12px; }
  .form-row { grid-template-columns: 1fr; }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workspace { grid-template-columns: 1fr; grid-template-rows: 360px minmax(420px, 1fr); }
  .detail-grid { grid-template-columns: 1fr; }
}`;

const DASHBOARD_JS = `const state = { tasks: [], selectedTaskId: undefined, filter: "", capabilities: { liveTaskManager: false, liveTaskTools: false } };

const els = {
  workflowPanel: document.getElementById("workflow-panel"),
  metrics: document.getElementById("metrics"),
  tasks: document.getElementById("tasks"),
  detail: document.getElementById("detail"),
  empty: document.getElementById("detail-empty"),
  updated: document.getElementById("updated"),
  refresh: document.getElementById("refresh"),
  filter: document.getElementById("status-filter"),
  form: document.getElementById("workflow-form"),
  submit: document.getElementById("workflow-submit"),
  formStatus: document.getElementById("workflow-status"),
  workspace: document.getElementById("workflow-workspace"),
  request: document.getElementById("workflow-request"),
  stage: document.getElementById("workflow-stage"),
  profile: document.getElementById("workflow-profile"),
  mode: document.getElementById("workflow-mode"),
  planId: document.getElementById("workflow-plan-id"),
  plannerProfile: document.getElementById("workflow-planner-profile"),
  executePlanId: document.getElementById("workflow-execute-plan-id"),
  planPath: document.getElementById("workflow-plan-path"),
  executorProfile: document.getElementById("workflow-executor-profile"),
  delegateFields: document.getElementById("delegate-fields"),
  planFields: document.getElementById("plan-fields"),
  executeFields: document.getElementById("execute-fields")
};

els.refresh.addEventListener("click", () => loadTasks());
els.filter.addEventListener("change", event => {
  state.filter = event.target.value;
  renderTasks();
});
els.form.addEventListener("submit", event => {
  event.preventDefault();
  submitWorkflow();
});
for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
}

function setTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  els.delegateFields.hidden = tab !== "delegate";
  els.planFields.hidden = tab !== "create-plan";
  els.executeFields.hidden = tab !== "execute-plan";
  els.request.required = tab !== "execute-plan";
  els.submit.textContent = tab === "create-plan" ? "Create plan" : tab === "execute-plan" ? "Execute plan" : "Delegate task";
  els.formStatus.textContent = "";
}

async function submitWorkflow() {
  const tab = state.tab || "delegate";
  const workspace = els.workspace.value.trim();
  const request = els.request.value.trim();
  const body = { workspace };
  let endpoint = "/api/delegate-task";
  if (tab === "delegate") {
    endpoint = "/api/delegate-task";
    body.request = request;
    body.mode = els.mode.value;
    body.stage = els.stage.value;
    body.profile = els.profile.value.trim() || undefined;
  } else if (tab === "create-plan") {
    endpoint = "/api/create-plan";
    body.request = request;
    body.planId = els.planId.value.trim() || undefined;
    body.plannerProfile = els.plannerProfile.value.trim() || undefined;
  } else {
    endpoint = "/api/execute-plan";
    body.mode = els.mode.value || "background";
    body.request = request || undefined;
    body.planId = els.executePlanId.value.trim() || undefined;
    body.planPath = els.planPath.value.trim() || undefined;
    body.executorProfile = els.executorProfile.value.trim() || undefined;
  }
  els.formStatus.textContent = "Running...";
  els.submit.disabled = true;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Request failed");
    els.formStatus.textContent = data.taskId ? "Task " + data.taskId + " created" : data.planId ? "Plan " + data.planId + " created" : "Done";
    await loadTasks();
    if (data.taskId) await loadDetail(data.taskId);
  } catch (error) {
    els.formStatus.textContent = error.message || String(error);
  } finally {
    els.submit.disabled = false;
  }
}

async function loadTasks() {
  const response = await fetch("/api/tasks");
  const data = await response.json();
  state.tasks = data.tasks || [];
  els.updated.textContent = "Updated " + new Date(data.generatedAt || Date.now()).toLocaleString();
  renderMetrics(data.summary || {});
  renderTasks();
  if (state.selectedTaskId) await loadDetail(state.selectedTaskId);
}

async function loadCapabilities() {
  const response = await fetch("/api/capabilities");
  const data = await response.json();
  state.capabilities = data;
  els.workflowPanel.hidden = !data.liveTaskTools;
}

function renderMetrics(summary) {
  const items = ["total", "running", "pending", "completed", "failed", "cancelled", "interrupted"];
  els.metrics.innerHTML = items.map(name => \`
    <div class="metric">
      <span>\${escapeHtml(name)}</span>
      <strong>\${Number(summary[name] || 0)}</strong>
    </div>
  \`).join("");
}

function renderTasks() {
  const tasks = state.filter ? state.tasks.filter(task => task.status === state.filter) : state.tasks;
  if (tasks.length === 0) {
    els.tasks.innerHTML = '<div class="empty">No tasks match this filter.</div>';
    return;
  }
  els.tasks.innerHTML = tasks.map(task => \`
    <button class="task-row \${task.id === state.selectedTaskId ? "active" : ""}" type="button" data-task-id="\${escapeAttr(task.id)}">
      <span class="task-title"><strong>\${escapeHtml(task.request || task.id)}</strong><span class="status \${escapeAttr(task.status)}">\${escapeHtml(task.status)}</span></span>
      <span class="meta">\${escapeHtml(task.workspace)}</span>
      <span class="meta">\${escapeHtml([task.profile, task.category, task.preferredAgent, (task.stages || []).join(" -> ")].filter(Boolean).join(" / "))}</span>
    </button>
  \`).join("");
  for (const button of els.tasks.querySelectorAll("[data-task-id]")) {
    button.addEventListener("click", () => loadDetail(button.dataset.taskId));
  }
}

async function loadDetail(taskId) {
  state.selectedTaskId = taskId;
  renderTasks();
  const response = await fetch("/api/tasks/" + encodeURIComponent(taskId));
  const data = await response.json();
  if (!data.ok) {
    els.empty.hidden = true;
    els.detail.hidden = false;
    els.detail.innerHTML = '<div class="panel">' + escapeHtml(data.error || "Failed to load task") + '</div>';
    return;
  }
  renderDetail(data.task, data.output || {});
}

async function cancelTask(taskId) {
  const response = await fetch("/api/tasks/" + encodeURIComponent(taskId) + "/cancel", { method: "POST" });
  const data = await response.json();
  if (!data.ok) {
    alert(data.error || "Failed to cancel task");
    return;
  }
  await loadTasks();
  await loadDetail(taskId);
}

function renderDetail(task, output) {
  const summary = output.transcriptSummary;
  const canCancel = state.capabilities.liveTaskManager && (task.status === "running" || task.status === "pending");
  els.empty.hidden = true;
  els.detail.hidden = false;
  els.detail.innerHTML = \`
    <div class="detail-grid">
      <div class="panel">
        <h3>Task</h3>
        \${kv("ID", task.id)}
        \${kv("Status", task.status)}
        \${kv("Run ID", task.runId)}
        \${kv("Workspace", task.workspace)}
        \${kv("Stages", (task.stages || []).join(" -> "))}
        \${kv("Plan", task.planId || "")}
        \${kv("Plan path", task.planPath || "")}
        \${kv("Profile", task.profile || "")}
        \${kv("Category", task.category || "")}
        \${canCancel ? '<div class="actions"><button class="danger-button" type="button" data-cancel-task="' + escapeAttr(task.id) + '">Cancel task</button></div>' : ''}
      </div>
      <div class="panel">
        <h3>Claude</h3>
        \${kv("Session", summary?.sessionId || task.agentSessionId || "")}
        \${kv("Models", (summary?.models || []).join(", "))}
        \${kv("Tool calls", String(summary?.toolCalls?.length || 0))}
        \${kv("Tokens", summary ? String(summary.usage.inputTokens + summary.usage.outputTokens) : "")}
      </div>
    </div>
    <div class="panel section">
      <h3>File writes</h3>
      <div class="pill-line">\${(summary?.fileWrites || []).map(file => '<span class="pill">' + escapeHtml(file) + '</span>').join("") || '<span class="meta">No file writes detected.</span>'}</div>
    </div>
    <div class="panel section">
      <h3>Artifacts</h3>
      \${(output.artifacts || []).map(artifact => '<h3>' + escapeHtml(artifact.path) + '</h3><pre>' + escapeHtml(artifact.content) + '</pre>').join("") || '<span class="meta">No artifact output available.</span>'}
    </div>
    <div class="panel section">
      <h3>Transcript timeline</h3>
      <pre>\${escapeHtml((summary?.timeline || []).map(item => [item.timestamp, item.type, item.summary].filter(Boolean).join(" | ")).join("\\n") || "No transcript summary available.")}</pre>
    </div>
  \`;
  const cancelButton = els.detail.querySelector("[data-cancel-task]");
  if (cancelButton) cancelButton.addEventListener("click", () => cancelTask(task.id));
}

function kv(label, value) {
  return '<div class="kv"><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(value || "-") + '</span></div>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(new RegExp(String.fromCharCode(96), "g"), "&#96;");
}

loadCapabilities().then(loadTasks);
setInterval(loadTasks, 3000);`;
