import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { readBackgroundOutput } from "../mcp/backgroundOutput.js";
import type { AutoDispatchArgs, CreatePlanArgs, DelegateTaskArgs, ExecutePlanArgs, RunCommandArgs, TaskToolSet } from "../mcp/tools.js";
import type { StabilityRunner, StabilityRunInput } from "../stability/StabilityRunner.js";
import type { DelegatedTask, TaskStatus } from "../types.js";
import type { TaskManager } from "../workflow/TaskManager.js";
import { TaskStore } from "../workflow/TaskStore.js";

export interface DashboardOptions {
  host?: string;
  port?: number;
  taskStore?: TaskStore;
  taskManager?: TaskManager;
  taskTools?: TaskToolSet;
  stabilityRunner?: StabilityRunner;
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
  const stabilityRunner = options.stabilityRunner;
  const maxBytes = options.maxBytes ?? 24_000;

  return createServer(async (request, response) => {
    try {
      await routeRequest(request, response, { taskStore, taskManager, taskTools, stabilityRunner, maxBytes });
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
  context: { taskStore: TaskStore; taskManager?: TaskManager; taskTools?: TaskToolSet; stabilityRunner?: StabilityRunner; maxBytes: number }
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
      liveTaskTools: Boolean(context.taskTools),
      liveStabilityRunner: Boolean(context.stabilityRunner)
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/stability-runs") {
    if (!context.stabilityRunner) {
      sendJson(response, 200, { ok: true, runs: [] });
      return;
    }
    sendJson(response, 200, { ok: true, runs: await context.stabilityRunner.list() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/stability-runs") {
    if (!context.stabilityRunner) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to a stability runner." });
      return;
    }
    const run = await context.stabilityRunner.start(await readJsonBody(request) as unknown as StabilityRunInput);
    sendJson(response, 200, { ok: true, runId: run.id, run });
    return;
  }
  if (url.pathname.startsWith("/api/stability-runs/")) {
    if (!context.stabilityRunner) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to a stability runner." });
      return;
    }
    const parts = url.pathname.slice("/api/stability-runs/".length).split("/");
    const runId = decodeURIComponent(parts[0] ?? "");
    if (!runId) {
      sendJson(response, 400, { ok: false, error: "runId is required" });
      return;
    }
    if (request.method === "POST" && parts[1] === "cancel") {
      const run = await context.stabilityRunner.cancel(runId);
      if (!run) {
        sendJson(response, 404, { ok: false, error: `Stability run not found: ${runId}` });
        return;
      }
      sendJson(response, 200, { ok: true, runId, run });
      return;
    }
    if (request.method === "GET" && parts.length === 1) {
      const run = await context.stabilityRunner.refresh(runId);
      if (!run) {
        sendJson(response, 404, { ok: false, error: `Stability run not found: ${runId}` });
        return;
      }
      sendJson(response, 200, { ok: true, runId, run });
      return;
    }
  }
  if (request.method === "GET" && url.pathname === "/api/catalog") {
    if (!context.taskTools) {
      sendJson(response, 200, { ok: true, agents: [], categories: [], profiles: [] });
      return;
    }
    const result = await context.taskTools.agentCatalogTool();
    sendToolResult(response, result);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/providers") {
    if (!context.taskTools) {
      sendJson(response, 200, { ok: false, checks: [] });
      return;
    }
    const result = await context.taskTools.providerDoctorTool();
    sendToolResult(response, result);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/commands") {
    if (!context.taskTools) {
      sendJson(response, 200, { ok: true, commands: [] });
      return;
    }
    const result = await context.taskTools.commandCatalogTool();
    sendToolResult(response, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/run-command") {
    if (!context.taskTools) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to live task tools." });
      return;
    }
    const result = await context.taskTools.runCommandTool(await readJsonBody(request) as unknown as RunCommandArgs);
    sendToolResult(response, result);
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
  if (request.method === "POST" && url.pathname === "/api/auto-dispatch") {
    if (!context.taskTools) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to live task tools." });
      return;
    }
    const result = await context.taskTools.autoDispatchTool(await readJsonBody(request) as unknown as AutoDispatchArgs);
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
    if (request.method === "POST" && (parts[1] === "retry" || parts[1] === "resume")) {
      if (!context.taskTools) {
        sendJson(response, 409, { ok: false, error: "Dashboard is not attached to live task tools." });
        return;
      }
      const result = parts[1] === "retry"
        ? await context.taskTools.taskRetryTool({ taskId })
        : await context.taskTools.taskResumeTool({ taskId });
      sendToolResult(response, result);
      return;
    }
    if (request.method === "POST" && parts[1] === "retry-failed-parts") {
      if (!context.taskManager) {
        sendJson(response, 409, { ok: false, error: "Dashboard is not attached to a live TaskManager." });
        return;
      }
      const task = await context.taskManager.retryFailedWorkflowParts(taskId);
      if (!task) {
        sendJson(response, 404, { ok: false, error: `Workflow task not found or cannot retry failed parts: ${taskId}` });
        return;
      }
      sendJson(response, 200, { ok: true, taskId: task.id, task });
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
    const output = await readBackgroundOutput(task, context.maxBytes, Number(url.searchParams.get("cursor") ?? 0), id => getTask(context, id));
    sendJson(response, 200, { ok: true, task, relatedTasks: relatedTasks(context, task), output });
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

function relatedTasks(context: { taskStore: TaskStore; taskManager?: TaskManager }, task: DelegatedTask): DelegatedTask[] {
  const ids = [...(task.childTaskIds ?? [])];
  if (task.reviewTaskId && !ids.includes(task.reviewTaskId)) ids.push(task.reviewTaskId);
  return ids.map(id => getTask(context, id)).filter((child): child is DelegatedTask => child !== undefined);
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
      <div class="top-actions">
        <div class="mode-toggle" id="workflow-mode-toggle" role="group" aria-label="Dashboard mode">
          <button class="mode-button active" id="simple-mode" type="button">Simple</button>
          <button class="mode-button" id="advanced-mode" type="button">Advanced</button>
        </div>
        <button id="refresh" type="button" title="Refresh tasks">Refresh</button>
      </div>
    </section>
    <section class="launch-grid">
    <section class="new-task" id="workflow-panel" hidden>
      <div class="tabbar" role="tablist" aria-label="New workflow">
        <button class="tab active" type="button" data-tab="command">Command</button>
        <button class="tab advanced-only" type="button" data-tab="auto">Auto Dispatch</button>
        <button class="tab advanced-only" type="button" data-tab="delegate">Delegate Task</button>
        <button class="tab advanced-only" type="button" data-tab="create-plan">Create Plan</button>
        <button class="tab advanced-only" type="button" data-tab="execute-plan">Execute Plan</button>
      </div>
      <form id="workflow-form" class="workflow-form">
        <label>Workspace<input id="workflow-workspace" name="workspace" placeholder="/absolute/path/to/project" required></label>
        <label class="request-field">Request<textarea id="workflow-request" name="request" rows="3" placeholder="Describe the work"></textarea></label>
        <label class="request-field">Verify command<input id="workflow-verify-command" name="verifyCommand" placeholder="optional, for example: npm test"></label>
        <div class="form-row" id="command-fields">
          <label>Command<select id="workflow-command" name="command"><option value="/ultrawork">/ultrawork</option><option value="/start-work">/start-work</option></select></label>
          <label>Agent<select id="workflow-agent" name="preferredAgent"><option value="">Auto</option><option value="claude">Claude</option><option value="codex-cli">Codex CLI</option><option value="gemini">Gemini</option><option value="opencode">OpenCode</option><option value="codex">Codex handoff</option></select></label>
        </div>
        <div class="form-row advanced-only" id="delegate-fields">
          <label>Stage<select id="workflow-stage" name="stage"><option value="implement">implement</option><option value="plan">plan</option><option value="review">review</option><option value="analyze">analyze</option></select></label>
          <label>Profile<input id="workflow-profile" name="profile" placeholder="coder"></label>
          <label>Mode<select id="workflow-mode" name="mode"><option value="background">background</option><option value="sync">sync</option></select></label>
        </div>
        <div class="form-row advanced-only" id="auto-fields">
          <label>Strategy<select id="workflow-strategy" name="strategy"><option value="auto">auto</option><option value="direct">direct</option><option value="plan">plan</option></select></label>
        </div>
        <div class="form-row advanced-only" id="plan-fields" hidden>
          <label>Plan ID<input id="workflow-plan-id" name="planId" placeholder="optional"></label>
          <label>Planner Profile<input id="workflow-planner-profile" name="plannerProfile" placeholder="optional"></label>
        </div>
        <div class="form-row advanced-only" id="execute-fields" hidden>
          <label>Plan ID<input id="workflow-execute-plan-id" name="executePlanId" placeholder="plan id"></label>
          <label>Plan Path<input id="workflow-plan-path" name="planPath" placeholder="or path"></label>
          <label>Executor Profile<input id="workflow-executor-profile" name="executorProfile" placeholder="coder"></label>
        </div>
        <div class="form-row advanced-only">
          <label>Requested model<input id="workflow-model" name="model" placeholder="provider default"></label>
          <label>Effort<select id="workflow-effort" name="effort"><option value="">default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label>
          <label>Timeout ms<input id="workflow-timeout" name="timeoutMs" type="number" min="1" step="1000" placeholder="default"></label>
          <label>Max repairs<input id="workflow-max-repair-attempts" name="maxRepairAttempts" type="number" min="0" step="1" placeholder="1"></label>
        </div>
        <label class="advanced-only">Skills<input id="workflow-skills" name="loadSkills" placeholder="comma-separated configured skill names"></label>
        <div class="form-actions">
          <button id="workflow-submit" type="submit">Run</button>
          <span id="workflow-status" class="form-status"></span>
        </div>
      </form>
    </section>
    <section class="providers" id="providers" hidden></section>
    </section>
    <section class="catalog advanced-only" id="catalog" hidden></section>
    <section class="stability advanced-only" id="stability-panel" hidden>
      <div class="panel-head">
        <h2>Stability runs</h2>
        <span class="meta">Long-running provider comparison</span>
      </div>
      <form id="stability-form" class="workflow-form">
        <label>Workspace root<input id="stability-workspace-root" placeholder="/tmp/codex-claude-stability" required></label>
        <label class="request-field">Request<textarea id="stability-request" rows="3" placeholder="Describe the repeated task each provider should run" required></textarea></label>
        <div class="form-row">
          <label>Providers<input id="stability-providers" value="claude,codex-cli,gemini" placeholder="claude,codex-cli,gemini"></label>
          <label>Iterations<input id="stability-iterations" type="number" min="1" step="1" value="1"></label>
          <label>Verify command<input id="stability-verify-command" placeholder="optional"></label>
        </div>
        <div class="form-actions">
          <button id="stability-submit" type="submit">Start stability run</button>
          <span id="stability-status" class="form-status"></span>
        </div>
      </form>
      <div id="stability-runs" class="stability-runs"></div>
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
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text); }
button, select { font: inherit; }
.shell { min-height: 100vh; padding: 20px; display: grid; grid-template-rows: auto auto auto auto 1fr; gap: 16px; }
.topbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.top-actions { display: flex; align-items: center; gap: 10px; }
.mode-toggle { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: #fff; }
.mode-button { border: 0; border-right: 1px solid var(--line); background: #fff; color: var(--muted); padding: 8px 10px; cursor: pointer; }
.mode-button:last-child { border-right: 0; }
.mode-button.active { background: #ccfbf1; color: #115e59; }
body[data-mode="simple"] .advanced-only { display: none !important; }
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
.catalog, .providers, .stability { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; display: grid; gap: 10px; }
.catalog-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.catalog-list { display: grid; gap: 6px; }
.catalog-row { border: 1px solid var(--line); border-radius: 6px; padding: 8px; display: grid; gap: 4px; }
.provider-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.provider-card { border: 1px solid var(--line); border-radius: 6px; padding: 10px; display: grid; gap: 5px; }
.provider-card.ready { border-color: #86efac; background: #f0fdf4; }
.provider-card.missing, .provider-card.failed { border-color: #fecaca; background: #fff1f2; }
.language-servers { border-top: 1px solid var(--line); padding-top: 10px; }
.language-servers summary { cursor: pointer; display: flex; justify-content: space-between; gap: 10px; align-items: center; font-weight: 700; }
.lsp-grid { margin-top: 10px; }
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
.secondary-button { border: 1px solid var(--line); background: #fff; color: var(--text); border-radius: 6px; padding: 7px 10px; cursor: pointer; }
.secondary-button:hover { border-color: var(--accent); }
.progress-track { height: 8px; background: #eef2f7; border-radius: 999px; overflow: hidden; margin: 10px 0; }
.progress-fill { height: 100%; background: var(--accent); }
.checklist { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 6px; }
.checklist li { display: grid; grid-template-columns: 24px 1fr; gap: 6px; font-size: 13px; }
.checklist .done { color: var(--ok); }
.checklist .todo { color: var(--muted); }
.io-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.io-tab { border: 1px solid var(--line); background: #fff; color: var(--text); border-radius: 6px; padding: 6px 9px; cursor: pointer; font-size: 12px; }
.io-tab.active { border-color: var(--accent); background: #ccfbf1; color: #115e59; }
.io-pane[hidden] { display: none; }
.io-path { color: var(--muted); font-size: 12px; margin: 0 0 8px; overflow-wrap: anywhere; }
.kv { display: grid; grid-template-columns: 120px 1fr; gap: 8px; font-size: 13px; margin-top: 6px; }
.kv span:first-child { color: var(--muted); }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #101828; color: #f8fafc; border-radius: 6px; padding: 12px; max-height: 360px; overflow: auto; }
.section { margin-top: 14px; }
.pill-line { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.pill { border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.workflow-map { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.workflow-node { border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: grid; gap: 6px; background: #f8fafc; min-width: 0; }
.workflow-node.completed { border-color: #86efac; background: #f0fdf4; }
.workflow-node.running { border-color: #bae6fd; background: #f0f9ff; }
.workflow-node.failed, .workflow-node.interrupted { border-color: #fecaca; background: #fff1f2; }
.workflow-node span { overflow-wrap: anywhere; }
.finding-list { margin: 0; padding-left: 18px; display: grid; gap: 7px; }
.finding-list li { font-size: 13px; line-height: 1.45; }
.stability-runs { display: grid; gap: 8px; }
.stability-run { border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: grid; gap: 8px; background: #f8fafc; }
.stability-run-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.provider-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.provider-summary-card { border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: #fff; display: grid; gap: 4px; }
.stability-task-list { display: grid; gap: 6px; margin-top: 8px; }
.stability-task { display: grid; grid-template-columns: 96px 90px minmax(0, 1fr) 80px; gap: 8px; align-items: center; border-top: 1px solid var(--line); padding-top: 6px; font-size: 12px; }
@media (max-width: 900px) {
  .shell { padding: 12px; }
  .form-row { grid-template-columns: 1fr; }
  .catalog-grid { grid-template-columns: 1fr; }
  .provider-grid { grid-template-columns: 1fr; }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workspace { grid-template-columns: 1fr; grid-template-rows: 360px minmax(420px, 1fr); }
  .detail-grid { grid-template-columns: 1fr; }
}

:root {
  --bg: #eef2f7;
  --panel: #ffffff;
  --line: #cfd7e3;
  --text: #111827;
  --muted: #64748b;
  --accent: #0f766e;
  --accent-strong: #134e4a;
  --blue: #2563eb;
  --amber: #b45309;
  --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
}
body { background: linear-gradient(180deg, #e7edf5 0, #f7f8fb 360px); }
.shell { max-width: 1480px; margin: 0 auto; grid-template-rows: auto auto auto auto 1fr; gap: 14px; }
.topbar { background: #172033; color: #f8fafc; border: 1px solid #263247; border-radius: 8px; padding: 16px 18px; box-shadow: var(--shadow); }
h1 { font-size: 22px; letter-spacing: 0; }
#updated { color: #b8c4d6; }
.mode-toggle { border-color: #334155; background: #111827; }
.mode-button { background: #111827; color: #cbd5e1; border-right-color: #334155; }
.mode-button.active { background: #14b8a6; color: #082f49; font-weight: 700; }
#refresh { background: #f8fafc; border-color: #dbe3ee; color: #172033; }
.launch-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 0.9fr); gap: 14px; align-items: stretch; }
.new-task, .providers, .catalog, .metric, .task-list, .panel { border-color: var(--line); box-shadow: var(--shadow); }
.new-task { padding: 16px; border-radius: 8px; }
.tabbar { background: #f1f5f9; border: 1px solid #dbe3ee; border-radius: 8px; padding: 4px; }
.tab { border: 0; background: transparent; color: #475569; font-size: 13px; }
.tab.active { background: #ffffff; border-color: transparent; color: var(--accent-strong); box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08); }
.workflow-form { gap: 12px; }
.workflow-form label { color: #475569; font-weight: 650; }
.workflow-form input, .workflow-form textarea, .workflow-form select {
  border-color: #cbd5e1;
  background: #f8fafc;
  min-height: 38px;
}
.workflow-form textarea { min-height: 92px; }
.workflow-form input:focus, .workflow-form textarea:focus, .workflow-form select:focus {
  outline: 2px solid rgba(20, 184, 166, 0.22);
  border-color: #14b8a6;
  background: #fff;
}
#workflow-submit { background: #0f766e; border-color: #0f766e; font-weight: 700; padding: 9px 14px; }
.providers { align-content: start; border-radius: 8px; }
.stability { border-radius: 8px; }
.provider-grid { grid-template-columns: 1fr; }
.provider-card { background: #f8fafc; border-radius: 8px; }
.provider-card.ready { border-color: #86efac; background: #effaf3; }
.provider-card.missing, .provider-card.failed { border-color: #fecaca; background: #fff5f5; }
.metrics { grid-template-columns: repeat(7, minmax(92px, 1fr)); }
.metric { border-radius: 8px; background: #ffffff; }
.metric span { color: #64748b; font-weight: 700; }
.metric strong { color: #0f172a; }
.workspace { grid-template-columns: minmax(320px, 420px) minmax(0, 1fr); }
.task-list { border-radius: 8px; background: #ffffff; }
.list-head { background: #f8fafc; }
.task-row { padding: 13px 14px; background: #fff; }
.task-row:hover, .task-row.active { background: #eefaf7; }
.task-title strong { font-size: 13px; }
.status { font-weight: 650; }
.detail { padding-bottom: 4px; }
.panel { border-radius: 8px; }
.detail-grid { align-items: start; }
.kv { grid-template-columns: 132px minmax(0, 1fr); }
pre { background: #0b1020; border: 1px solid #1e293b; }
.io-tab.active { background: #0f766e; color: #fff; }

@media (max-width: 1100px) {
  .launch-grid { grid-template-columns: 1fr; }
  .provider-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 900px) {
  .topbar { align-items: stretch; flex-direction: column; }
  .top-actions { justify-content: space-between; }
  .provider-grid { grid-template-columns: 1fr; }
}`;

const DASHBOARD_JS = `const SIMPLE_COMMANDS = ["ultrawork", "start-work", "plan-work", "review-work", "explore"];
const SIMPLE_COMMAND_SET = new Set(SIMPLE_COMMANDS);

const state = { tasks: [], commands: [], stabilityRuns: [], mode: "simple", selectedTaskId: undefined, filter: "", selectedIoTab: undefined, capabilities: { liveTaskManager: false, liveTaskTools: false, liveStabilityRunner: false } };

const els = {
  workflowPanel: document.getElementById("workflow-panel"),
  catalog: document.getElementById("catalog"),
  stabilityPanel: document.getElementById("stability-panel"),
  stabilityForm: document.getElementById("stability-form"),
  stabilityWorkspaceRoot: document.getElementById("stability-workspace-root"),
  stabilityRequest: document.getElementById("stability-request"),
  stabilityProviders: document.getElementById("stability-providers"),
  stabilityIterations: document.getElementById("stability-iterations"),
  stabilityVerifyCommand: document.getElementById("stability-verify-command"),
  stabilitySubmit: document.getElementById("stability-submit"),
  stabilityStatus: document.getElementById("stability-status"),
  stabilityRuns: document.getElementById("stability-runs"),
  providers: document.getElementById("providers"),
  metrics: document.getElementById("metrics"),
  tasks: document.getElementById("tasks"),
  detail: document.getElementById("detail"),
  empty: document.getElementById("detail-empty"),
  updated: document.getElementById("updated"),
  refresh: document.getElementById("refresh"),
  simpleMode: document.getElementById("simple-mode"),
  advancedMode: document.getElementById("advanced-mode"),
  filter: document.getElementById("status-filter"),
  form: document.getElementById("workflow-form"),
  submit: document.getElementById("workflow-submit"),
  formStatus: document.getElementById("workflow-status"),
  workspace: document.getElementById("workflow-workspace"),
  request: document.getElementById("workflow-request"),
  command: document.getElementById("workflow-command"),
  stage: document.getElementById("workflow-stage"),
  profile: document.getElementById("workflow-profile"),
  mode: document.getElementById("workflow-mode"),
  strategy: document.getElementById("workflow-strategy"),
  planId: document.getElementById("workflow-plan-id"),
  plannerProfile: document.getElementById("workflow-planner-profile"),
  executePlanId: document.getElementById("workflow-execute-plan-id"),
  planPath: document.getElementById("workflow-plan-path"),
  executorProfile: document.getElementById("workflow-executor-profile"),
  agent: document.getElementById("workflow-agent"),
  model: document.getElementById("workflow-model"),
  effort: document.getElementById("workflow-effort"),
  timeout: document.getElementById("workflow-timeout"),
  verifyCommand: document.getElementById("workflow-verify-command"),
  maxRepairAttempts: document.getElementById("workflow-max-repair-attempts"),
  skills: document.getElementById("workflow-skills"),
  commandFields: document.getElementById("command-fields"),
  autoFields: document.getElementById("auto-fields"),
  delegateFields: document.getElementById("delegate-fields"),
  planFields: document.getElementById("plan-fields"),
  executeFields: document.getElementById("execute-fields")
};

els.refresh.addEventListener("click", () => {
  loadTasks();
  loadStabilityRuns();
});
els.simpleMode.addEventListener("click", () => setMode("simple"));
els.advancedMode.addEventListener("click", () => setMode("advanced"));
els.filter.addEventListener("change", event => {
  state.filter = event.target.value;
  renderTasks();
});
els.form.addEventListener("submit", event => {
  event.preventDefault();
  submitWorkflow();
});
els.stabilityForm.addEventListener("submit", event => {
  event.preventDefault();
  submitStabilityRun();
});
for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
}

function setMode(mode) {
  state.mode = mode === "advanced" ? "advanced" : "simple";
  document.body.dataset.mode = state.mode;
  els.simpleMode.classList.toggle("active", state.mode === "simple");
  els.advancedMode.classList.toggle("active", state.mode === "advanced");
  if (state.mode === "simple" && state.tab !== "command") {
    setTab("command");
  }
  renderCommands();
}

function setTab(tab) {
  if (state.mode !== "advanced" && tab !== "command") tab = "command";
  state.tab = tab;
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  els.commandFields.hidden = tab !== "command";
  els.autoFields.hidden = tab !== "auto";
  els.delegateFields.hidden = tab !== "delegate";
  els.planFields.hidden = tab !== "create-plan";
  els.executeFields.hidden = tab !== "execute-plan";
  els.request.required = tab !== "execute-plan";
  els.submit.textContent = tab === "create-plan" ? "Create plan" : tab === "execute-plan" ? "Execute plan" : tab === "auto" ? "Auto dispatch" : tab === "command" ? "Run command" : "Delegate task";
  els.formStatus.textContent = "";
}

async function submitWorkflow() {
  const tab = state.tab || "command";
  const workspace = els.workspace.value.trim();
  const request = els.request.value.trim();
  const body = { workspace };
  const model = els.model.value.trim();
  const preferredAgent = els.agent.value;
  const effort = els.effort.value;
  const timeoutMs = Number(els.timeout.value);
  const verifyCommand = els.verifyCommand.value.trim();
  const maxRepairAttempts = Number(els.maxRepairAttempts.value);
  const loadSkills = parseSkills(els.skills.value);
  if (preferredAgent) body.preferredAgent = preferredAgent;
  if (verifyCommand && tab !== "create-plan") body.verifyCommand = verifyCommand;
  if (state.mode === "advanced") {
    if (model) body.model = model;
    if (effort) body.effort = effort;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) body.timeoutMs = timeoutMs;
    if (Number.isInteger(maxRepairAttempts) && maxRepairAttempts >= 0) body.maxRepairAttempts = maxRepairAttempts;
    if (loadSkills.length > 0) body.loadSkills = loadSkills;
  }
  let endpoint = "/api/delegate-task";
  if (tab === "command") {
    endpoint = "/api/run-command";
    body.command = els.command.value;
    body.request = request || undefined;
    body.mode = els.mode.value;
    body.strategy = els.strategy.value;
  } else if (tab === "auto") {
    endpoint = "/api/auto-dispatch";
    body.request = request;
    body.mode = els.mode.value;
    body.strategy = els.strategy.value;
  } else if (tab === "delegate") {
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
  els.catalog.hidden = !data.liveTaskTools;
  els.providers.hidden = !data.liveTaskTools;
  els.stabilityPanel.hidden = !data.liveStabilityRunner;
  if (data.liveTaskTools) await loadProviders();
  if (data.liveTaskTools) await loadCatalog();
  if (data.liveTaskTools) await loadCommands();
  if (data.liveStabilityRunner) await loadStabilityRuns();
}

async function submitStabilityRun() {
  const workspaceRoot = els.stabilityWorkspaceRoot.value.trim();
  const request = els.stabilityRequest.value.trim();
  const providers = parseSkills(els.stabilityProviders.value);
  const iterations = Number(els.stabilityIterations.value);
  const verifyCommand = els.stabilityVerifyCommand.value.trim();
  const body = {
    workspaceRoot,
    request,
    providers,
    iterations: Number.isInteger(iterations) && iterations > 0 ? iterations : 1
  };
  if (verifyCommand) body.verifyCommand = verifyCommand;
  els.stabilityStatus.textContent = "Starting...";
  els.stabilitySubmit.disabled = true;
  try {
    const response = await fetch("/api/stability-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Stability run failed");
    els.stabilityStatus.textContent = "Run " + data.runId + " started";
    await loadStabilityRuns();
    await loadTasks();
  } catch (error) {
    els.stabilityStatus.textContent = error.message || String(error);
  } finally {
    els.stabilitySubmit.disabled = false;
  }
}

async function loadStabilityRuns() {
  if (!state.capabilities.liveStabilityRunner) return;
  const response = await fetch("/api/stability-runs");
  const data = await response.json();
  state.stabilityRuns = data.runs || [];
  renderStabilityRuns();
}

function renderStabilityRuns() {
  if (!els.stabilityRuns) return;
  els.stabilityRuns.innerHTML = state.stabilityRuns.length === 0
    ? '<span class="meta">No stability runs yet.</span>'
    : state.stabilityRuns.map(renderStabilityRun).join("");
  for (const button of els.stabilityRuns.querySelectorAll("[data-cancel-stability]")) {
    button.addEventListener("click", () => cancelStabilityRun(button.dataset.cancelStability));
  }
}

function renderStabilityRun(run) {
  const byProvider = run.summary?.byProvider || {};
  return \`
    <div class="stability-run">
      <div class="stability-run-head">
        <strong>\${escapeHtml(run.id)}</strong>
        <span class="status \${escapeAttr(run.status)}">\${escapeHtml(run.status)}</span>
      </div>
      \${kv("Request", run.request || "")}
      \${kv("Tasks", String(run.summary?.completed || 0) + "/" + String(run.summary?.total || 0) + " completed, " + String(run.summary?.failed || 0) + " failed")}
      <div class="provider-summary">\${Object.entries(byProvider).map(([provider, summary]) => renderProviderSummary(provider, summary)).join("")}</div>
      <details>
        <summary>Task details</summary>
        <div class="stability-task-list">\${(run.tasks || []).map(renderStabilityTask).join("")}</div>
      </details>
      \${run.status === "running" ? '<button class="secondary-button" type="button" data-cancel-stability="' + escapeAttr(run.id) + '">Cancel run</button>' : ''}
    </div>
  \`;
}

function renderProviderSummary(provider, summary) {
  return '<div class="provider-summary-card"><strong>' + escapeHtml(provider) + '</strong>' +
    '<span class="meta">success ' + escapeHtml(Math.round(Number(summary.successRate || 0) * 100)) + '%</span>' +
    '<span class="meta">completed ' + escapeHtml(summary.completed || 0) + ' / failed ' + escapeHtml(summary.failed || 0) + '</span>' +
    (summary.averageDurationMs ? '<span class="meta">avg ' + escapeHtml(summary.averageDurationMs) + 'ms</span>' : '') +
    ((summary.failureSamples || []).length > 0 ? '<span class="meta">' + escapeHtml(summary.failureSamples[0]) + '</span>' : '') +
    '</div>';
}

function renderStabilityTask(task) {
  return '<div class="stability-task"><span>' + escapeHtml(task.provider + ' #' + task.iteration) + '</span>' +
    '<span class="status ' + escapeAttr(task.status) + '">' + escapeHtml(task.status) + '</span>' +
    '<span class="meta">' + escapeHtml(task.taskId) + '</span>' +
    (task.durationMs ? '<span class="meta">' + escapeHtml(task.durationMs) + 'ms</span>' : '') +
    (task.error ? '<span class="meta">' + escapeHtml(task.error) + '</span>' : '') +
    '</div>';
}

async function cancelStabilityRun(runId) {
  const response = await fetch("/api/stability-runs/" + encodeURIComponent(runId) + "/cancel", { method: "POST" });
  const data = await response.json();
  if (!data.ok) alert(data.error || "Failed to cancel stability run");
  await loadStabilityRuns();
  await loadTasks();
}

async function loadProviders() {
  const response = await fetch("/api/providers");
  const data = await response.json();
  if (!data.checks) return;
  renderProviders(data);
}

function renderProviders(data) {
  const lspSummary = data.languageServerSummary || {};
  els.providers.innerHTML = \`
    <h2>Provider health</h2>
    <div class="provider-grid">\${(data.checks || []).map(check => \`
      <div class="provider-card \${escapeAttr(check.status)}">
        <strong>\${escapeHtml(check.provider)}</strong>
        <span class="meta">\${escapeHtml(check.status)}</span>
        <span class="meta">\${escapeHtml(check.version || check.error || check.command || "")}</span>
      </div>
    \`).join("")}</div>
    <details class="language-servers">
      <summary><span>Language servers</span><span id="language-server-summary" class="meta">\${Number(lspSummary.ready || 0)}/\${Number(lspSummary.total || 0)} ready</span></summary>
      <div class="provider-grid lsp-grid">\${(data.languageServers || []).map(check => \`
        <div class="provider-card \${escapeAttr(check.status)}">
          <strong>\${escapeHtml(check.language)}</strong>
          <span class="meta">\${escapeHtml(check.status)}</span>
          <span class="meta">\${escapeHtml(check.version || check.error || check.command || "")}</span>
        </div>
      \`).join("")}</div>
    </details>
  \`;
}

async function loadCommands() {
  const response = await fetch("/api/commands");
  const data = await response.json();
  if (!data.ok) return;
  state.commands = data.commands || [];
  renderCommands();
}

function renderCommands() {
  const commands = state.mode === "simple"
    ? SIMPLE_COMMANDS.map(name => (state.commands || []).find(command => command.name === name)).filter(Boolean)
    : (state.commands || []);
  els.command.innerHTML = commands.map(command =>
    '<option value="/' + escapeAttr(command.name) + '">/' + escapeHtml(command.name) + '</option>'
  ).join("") || '<option value="/ultrawork">/ultrawork</option>';
}

async function loadCatalog() {
  const response = await fetch("/api/catalog");
  const data = await response.json();
  if (!data.ok) return;
  renderCatalog(data);
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

function renderCatalog(catalog) {
  const agents = (catalog.agents || []).map(item => catalogRow(item.name, [
    item.description,
    labelValue("stages", (item.defaultStages || []).join(" -> ")),
    labelValue("categories", (item.categories || []).join(", "))
  ]));
  const profiles = (catalog.profiles || []).map(item => catalogRow(item.name, [
    item.description,
    labelValue("agent", item.agent),
    labelValue("stage", (item.stages || []).join(" -> ")),
    labelValue("model", item.model || "Claude CLI default"),
    labelValue("effort", item.effort || "default"),
    labelValue("role", item.rolePrompt ? "enabled" : "")
  ]));
  const categories = (catalog.categories || []).map(item => catalogRow(item.name, [
    item.description,
    labelValue("agent", item.agent),
    labelValue("model", item.model || "agent default"),
    labelValue("effort", item.effort || "default")
  ]));
  els.catalog.innerHTML = \`
    <h2>Agent defaults</h2>
    <div class="catalog-grid">
      <div><h3>Agents</h3><div class="catalog-list">\${agents.join("") || '<span class="meta">No agents.</span>'}</div></div>
      <div><h3>Profiles</h3><div class="catalog-list">\${profiles.join("") || '<span class="meta">No profiles.</span>'}</div></div>
      <div><h3>Categories</h3><div class="catalog-list">\${categories.join("") || '<span class="meta">No categories.</span>'}</div></div>
    </div>
  \`;
}

function catalogRow(title, lines) {
  return '<div class="catalog-row"><strong>' + escapeHtml(title) + '</strong>' +
    lines.filter(Boolean).map(line => '<span class="meta">' + escapeHtml(line) + '</span>').join("") +
    '</div>';
}

function labelValue(label, value) {
  return value ? label + ": " + value : "";
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
      <span class="meta">\${escapeHtml([task.kind === "workflow" ? "workflow" : "", task.parentTaskId ? "child of " + task.parentTaskId : "", task.profile, task.category, task.preferredAgent, (task.stages || []).join(" -> ")].filter(Boolean).join(" / "))}</span>
      \${task.verification ? '<span class="meta">verify: ' + escapeHtml(task.verification.status) + (task.verification.repairTaskId ? ' / repair ' + escapeHtml(task.verification.repairTaskId) : '') + '</span>' : ''}
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
  renderDetail(data.task, data.output || {}, data.relatedTasks || []);
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

async function rerunTask(taskId, action) {
  const response = await fetch("/api/tasks/" + encodeURIComponent(taskId) + "/" + action, { method: "POST" });
  const data = await response.json();
  if (!data.ok) {
    alert(data.error || "Task action failed");
    return;
  }
  await loadTasks();
  if (data.taskId) await loadDetail(data.taskId);
}

function renderDetail(task, output, relatedTasks) {
  const summary = output.transcriptSummary;
  const plan = task.workflow?.summary ? workflowPlanSummary(task, output.planSummary) : output.planSummary;
  const canCancel = state.capabilities.liveTaskManager && (task.status === "running" || task.status === "pending");
  const canRetry = task.kind !== "workflow" && state.capabilities.liveTaskTools && ["failed", "interrupted", "cancelled"].includes(task.status);
  const canRetryFailedParts = task.kind === "workflow" && state.capabilities.liveTaskManager && ["failed", "interrupted", "cancelled"].includes(task.status);
  const canResume = canRetry && Boolean(task.agentSessionId || summary?.sessionId);
  els.empty.hidden = true;
  els.detail.hidden = false;
  els.detail.innerHTML = \`
    \${renderOutcomePanel(task, output)}
    \${renderWorkflowMap(task, relatedTasks || [])}
    <div class="detail-grid">
      <div class="panel">
        <h3>Task</h3>
        \${kv("ID", task.id)}
        \${kv("Status", task.status)}
        \${kv("Run ID", task.runId)}
        \${kv("Kind", task.kind || "task")}
        \${kv("Workspace", task.workspace)}
        \${kv("Stages", (task.stages || []).join(" -> "))}
        \${kv("Plan", task.planId || "")}
        \${kv("Plan path", task.planPath || "")}
        \${kv("Parent task", task.parentTaskId || "")}
        \${kv("Child tasks", summarizeIdList(task.childTaskIds || []))}
        \${kv("Depends on", summarizeIdList(task.dependsOnTaskIds || []))}
        \${kv("Review task", task.reviewTaskId || "")}
        \${task.workflow?.summary ? kv("Workflow", workflowSummary(task.workflow.summary)) : ""}
        \${kv("Retry of", task.retryOf || "")}
        \${kv("Resume of", task.resumeOf || "")}
        \${kv("Repair of", task.repairOf || "")}
        \${kv("Profile", task.profile || "")}
        \${kv("Category", task.category || "")}
        \${kv("Preferred agent", task.preferredAgent || "")}
        \${kv("Requested model", task.model || "")}
        \${kv("Effort", task.effort || "")}
        \${kv("Timeout", task.timeoutMs ? String(task.timeoutMs) + "ms" : "")}
        \${kv("Verify command", task.verifyCommand || "")}
        \${kv("Repair attempt", task.repairAttempt !== undefined ? String(task.repairAttempt) : "")}
        \${kv("Max repairs", task.maxRepairAttempts !== undefined ? String(task.maxRepairAttempts) : "")}
        \${kv("Skills", (task.skills || []).map(skill => skill.name).join(", "))}
        \${canCancel || canRetry || canResume || canRetryFailedParts ? '<div class="actions">' +
          (canCancel ? '<button class="danger-button" type="button" data-cancel-task="' + escapeAttr(task.id) + '">Cancel task</button>' : '') +
          (canRetryFailedParts ? '<button class="secondary-button" type="button" data-retry-failed-parts="' + escapeAttr(task.id) + '">Retry failed parts</button>' : '') +
          (canRetry ? '<button class="secondary-button" type="button" data-retry-task="' + escapeAttr(task.id) + '">Retry</button>' : '') +
          (canResume ? '<button class="secondary-button" type="button" data-resume-task="' + escapeAttr(task.id) + '">Resume</button>' : '') +
          '</div>' : ''}
      </div>
      <div class="panel">
        <h3>Claude</h3>
        \${kv("Session", summary?.sessionId || task.agentSessionId || "")}
        \${kv("Actual models", (summary?.models || []).join(", "))}
        \${kv("Tool calls", String(summary?.toolCalls?.length || 0))}
        \${kv("Tokens", summary ? String(summary.usage.inputTokens + summary.usage.outputTokens) : "")}
      </div>
    </div>
    \${renderWorkflowStatePanel(task)}
    \${renderVerificationPanel(task)}
    \${plan ? renderPlanSummary(plan) : ''}
    \${renderChangedFilesPanel(task, summary)}
    \${renderFindingsPanel(task, output)}
    \${renderLiveIo(output)}
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
  const retryButton = els.detail.querySelector("[data-retry-task]");
  if (retryButton) retryButton.addEventListener("click", () => rerunTask(task.id, "retry"));
  const retryFailedPartsButton = els.detail.querySelector("[data-retry-failed-parts]");
  if (retryFailedPartsButton) retryFailedPartsButton.addEventListener("click", () => rerunTask(task.id, "retry-failed-parts"));
  const resumeButton = els.detail.querySelector("[data-resume-task]");
  if (resumeButton) resumeButton.addEventListener("click", () => rerunTask(task.id, "resume"));
  for (const button of els.detail.querySelectorAll("[data-io-tab]")) {
    button.addEventListener("click", () => selectIoTab(button.dataset.ioTab));
  }
}

function renderWorkflowStatePanel(task) {
  const workflowState = task.workflow?.state;
  if (!workflowState) return "";
  return \`
    <div class="panel section">
      <h3>Workflow state</h3>
      \${kv("Phase", workflowState.phase || "")}
      \${kv("Next action", workflowState.nextAction?.kind || "")}
      \${kv("Reason", workflowState.nextAction?.reason || "")}
      \${kv("State path", workflowState.statePath || task.workflow?.statePath || "")}
      <ul class="checklist">\${(workflowState.steps || []).map(step => '<li><span class="' + (step.status === 'completed' ? 'done' : 'todo') + '">' + escapeHtml(step.status || '') + '</span><span>' + escapeHtml((step.kind || 'task') + ' ' + (step.taskId || '') + ': ' + (step.text || '')) + '</span></li>').join("") || '<li><span></span><span class="meta">No workflow steps recorded.</span></li>'}</ul>
      \${(workflowState.learnings || []).length > 0 ? '<h3>Learnings</h3><ul class="finding-list">' + workflowState.learnings.map(learning => '<li>' + escapeHtml(learning.taskId + ': ' + learning.summary) + '</li>').join("") + '</ul>' : ''}
    </div>
  \`;
}

function renderVerificationPanel(task) {
  if (!task.verifyCommand && !task.verification) return "";
  const verification = task.verification || {};
  const output = [
    verification.stdout ? "stdout:\\n" + verification.stdout : "",
    verification.stderr ? "stderr:\\n" + verification.stderr : "",
    verification.error ? "error:\\n" + verification.error : ""
  ].filter(Boolean).join("\\n\\n");
  return \`
    <div class="panel section">
      <h3>Verification</h3>
      \${kv("Command", verification.command || task.verifyCommand || "")}
      \${kv("Status", verification.status || "not started")}
      \${kv("Exit code", verification.exitCode === undefined ? "" : String(verification.exitCode))}
      \${kv("Timed out", verification.timedOut ? "true" : "")}
      \${kv("Started", verification.startedAt || "")}
      \${kv("Finished", verification.finishedAt || "")}
      \${kv("Repair task", verification.repairTaskId || "")}
      \${output ? '<pre>' + escapeHtml(output) + '</pre>' : '<span class="meta">No verification output available.</span>'}
    </div>
  \`;
}

function renderOutcomePanel(task, output) {
  const report = finalReportArtifact(output);
  const stageSummary = stageResults(task).map(result => result.summary).filter(Boolean).join("\\n\\n");
  const content = report?.content || stageSummary || task.error || "";
  return \`
    <div class="panel section outcome-panel">
      <div class="panel-head"><h3>Final report</h3>\${report ? '<span class="meta">' + escapeHtml(report.path) + '</span>' : ''}</div>
      <pre>\${escapeHtml(content || "No final report is available yet.")}</pre>
    </div>
  \`;
}

function renderWorkflowMap(task, relatedTasks) {
  if (task.kind !== "workflow" && relatedTasks.length === 0) return "";
  const nodes = relatedTasks.length > 0 ? relatedTasks : (task.childTaskIds || []).map(id => ({ id, status: "pending" }));
  return \`
    <div class="panel section">
      <h3>Workflow map</h3>
      <div class="workflow-map">
        <div class="workflow-node \${escapeAttr(task.status)}">
          <strong>Parent</strong>
          <span>\${escapeHtml(task.id)}</span>
          <span class="status \${escapeAttr(task.status)}">\${escapeHtml(task.status)}</span>
        </div>
        \${nodes.map(node => '<div class="workflow-node ' + escapeAttr(node.status || "") + '"><strong>' + escapeHtml(node.id === task.reviewTaskId ? "Review" : "Child") + '</strong><span>' + escapeHtml(node.id) + '</span><span class="meta">' + escapeHtml([node.profile, (node.stages || []).join(" -> ")].filter(Boolean).join(" / ")) + '</span><span class="status ' + escapeAttr(node.status || "") + '">' + escapeHtml(node.status || "unknown") + '</span></div>').join("")}
      </div>
    </div>
  \`;
}

function renderChangedFilesPanel(task, summary) {
  const files = Array.from(new Set([
    ...(summary?.fileWrites || []),
    ...stageResults(task).flatMap(result => result.changedFiles || [])
  ])).filter(Boolean);
  return \`
    <div class="panel section">
      <h3>Changed files</h3>
      <div class="pill-line">\${files.map(file => '<span class="pill">' + escapeHtml(file) + '</span>').join("") || '<span class="meta">No changed files or file writes detected.</span>'}</div>
    </div>
  \`;
}

function renderFindingsPanel(task, output) {
  const findings = extractFindings(task, output);
  return \`
    <div class="panel section findings-panel">
      <h3>Review findings</h3>
      \${findings.length > 0 ? '<ul class="finding-list">' + findings.map(finding => '<li>' + escapeHtml(finding) + '</li>').join("") + '</ul>' : '<span class="meta">No review findings detected.</span>'}
    </div>
  \`;
}

function renderPlanSummary(plan) {
  return \`
    <div class="panel section">
      <h3>Plan progress</h3>
      \${kv("Plan", plan.path || "")}
      \${kv("Progress", String(plan.completedSteps || 0) + "/" + String(plan.totalSteps || 0) + " (" + String(plan.progressPercent || 0) + "%)")}
      <div class="progress-track"><div class="progress-fill" style="width: \${Number(plan.progressPercent || 0)}%"></div></div>
      <ul class="checklist">\${(plan.steps || []).map(step => '<li><span class="' + (step.completed ? 'done' : 'todo') + '">' + (step.completed ? '[x]' : '[ ]') + '</span><span>' + escapeHtml(step.text) + '</span></li>').join("") || '<li><span></span><span class="meta">No checklist steps found.</span></li>'}</ul>
    </div>
  \`;
}

function workflowPlanSummary(task, plan) {
  const summary = task.workflow?.summary;
  if (!summary) return plan;
  const steps = (task.childTaskIds || []).map((id, index) => {
    const isReview = id === task.reviewTaskId;
    return {
      text: (isReview ? "Review: " : "Task: ") + id,
      completed: summary.completed > index,
      line: index + 1
    };
  });
  return {
    path: task.planPath || plan?.path || "",
    totalSteps: Number(summary.total || 0),
    completedSteps: Number(summary.completed || 0),
    progressPercent: summary.total ? Math.round((Number(summary.completed || 0) / Number(summary.total || 1)) * 100) : 0,
    steps: steps.length > 0 ? steps : plan?.steps || []
  };
}

function renderLiveIo(output) {
  const panes = buildLiveIoPanes(output);
  if (panes.length === 0) {
    return \`
      <div class="panel section">
        <h3>Live I/O</h3>
        <span class="meta">No input, output, log, or transcript content is available yet.</span>
      </div>
    \`;
  }
  const activeId = panes.some(pane => pane.id === state.selectedIoTab) ? state.selectedIoTab : panes[0].id;
  state.selectedIoTab = activeId;
  return \`
    <div class="panel section live-io">
      <h3>Live I/O</h3>
      <div class="io-tabs">\${panes.map(pane => '<button class="io-tab ' + (pane.id === activeId ? 'active' : '') + '" type="button" data-io-tab="' + escapeAttr(pane.id) + '">' + escapeHtml(pane.label) + '</button>').join("")}</div>
      \${panes.map(pane => '<div class="io-pane" data-io-pane="' + escapeAttr(pane.id) + '"' + (pane.id === activeId ? '' : ' hidden') + '><p class="io-path">' + escapeHtml(pane.path) + '</p><pre>' + escapeHtml(pane.content || "(empty)") + '</pre></div>').join("")}
    </div>
  \`;
}

function buildLiveIoPanes(output) {
  const panes = [];
  for (const artifact of output.artifacts || []) {
    const kind = artifactKind(artifact.path);
    if (!kind) continue;
    panes.push({
      id: kind.id + "-" + panes.length,
      label: kind.label,
      path: artifact.path,
      content: artifact.content || ""
    });
  }
  if (output.transcript?.tail) {
    panes.push({
      id: "transcript-" + panes.length,
      label: "Transcript",
      path: output.transcript.path || "",
      content: output.transcript.tail
    });
  }
  const order = ["Input", "Result", "CLI Stream", "CLI stderr", "Debug log", "Transcript"];
  return panes.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

function finalReportArtifact(output) {
  const artifacts = output.artifacts || [];
  return artifacts.find(artifact => artifact.path === "workflow-output.md")
    || [...artifacts].reverse().find(artifact => artifact.path?.endsWith(".output.md"))
    || artifacts.find(artifact => artifact.path?.endsWith(".md"));
}

function extractFindings(task, output) {
  const reviewArtifacts = (output.artifacts || []).filter(artifact =>
    artifact.path === "workflow-output.md" || artifact.path?.includes("review") || /review|momus/i.test(artifact.content || "")
  );
  const reviewText = reviewArtifacts.map(artifact => artifact.content || "").join("\\n");
  const lines = reviewText
    .split(/\\r?\\n/)
    .map(line => line.trim())
    .filter(line => /^(?:[-*]\\s*)?(?:finding|issue|bug|risk|regression|missing|error|failed|问题|风险|缺陷|失败|建议)/i.test(line));
  if (lines.length > 0) return lines.slice(0, 12);
  return stageResults(task)
    .filter(result => result.stage === "review" && result.summary)
    .map(result => result.summary)
    .slice(0, 12);
}

function stageResults(task) {
  const results = task?.result?.results;
  return Array.isArray(results) ? results.filter(result => result && typeof result === "object") : [];
}

function artifactKind(path) {
  if (path.endsWith(".input.md")) return { id: "input", label: "Input" };
  if (path.endsWith(".output.md")) return { id: "result", label: "Result" };
  if (path.endsWith(".stdout.jsonl")) return { id: "cli-stdout", label: "CLI Stream" };
  if (path.endsWith(".stdout.log")) return { id: "cli-stdout", label: "CLI Stream" };
  if (path.endsWith(".stderr.log")) return { id: "cli-stderr", label: "CLI stderr" };
  if (path.endsWith(".log")) return { id: "debug-log", label: "Debug log" };
  return undefined;
}

function selectIoTab(tabId) {
  state.selectedIoTab = tabId;
  for (const button of els.detail.querySelectorAll("[data-io-tab]")) {
    button.classList.toggle("active", button.dataset.ioTab === tabId);
  }
  for (const pane of els.detail.querySelectorAll("[data-io-pane]")) {
    pane.hidden = pane.dataset.ioPane !== tabId;
  }
}

function kv(label, value) {
  return '<div class="kv"><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(value || "-") + '</span></div>';
}

function workflowSummary(summary) {
  return [
    "total " + Number(summary.total || 0),
    "completed " + Number(summary.completed || 0),
    "failed " + Number(summary.failed || 0),
    "running " + Number(summary.running || 0),
    "pending " + Number(summary.pending || 0)
  ].join(", ");
}

function summarizeIdList(ids) {
  if (!ids || ids.length === 0) return "";
  const visible = ids.slice(0, 4).join(", ");
  return ids.length > 4 ? visible + " +" + String(ids.length - 4) + " more" : visible;
}

function parseSkills(value) {
  return value.split(",").map(skill => skill.trim()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(new RegExp(String.fromCharCode(96), "g"), "&#96;");
}

setMode("simple");
setTab("command");
loadCapabilities().then(loadTasks);
setInterval(() => {
  loadTasks();
  loadStabilityRuns();
}, 3000);`;
