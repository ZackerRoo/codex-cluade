import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { stat } from "node:fs/promises";
import { artifactPaths, readBackgroundOutput } from "../mcp/backgroundOutput.js";
import type { AutoDispatchArgs, CreatePlanArgs, DelegateTaskArgs, ExecutePlanArgs, RunCommandArgs, TaskPreviewArgs, TaskToolSet, TeamAutonomyRunArgs, TeamCoordinatorRunArgs, TeamCreateArgs, TeamCreateFromTemplateArgs, TeamMessageArgs, TeamRoundRunArgs, TeamTaskCreateArgs, TeamTaskStartArgs, TeamTaskUpdateArgs } from "../mcp/tools.js";
import type { StabilityRunner, StabilityRunInput } from "../stability/StabilityRunner.js";
import type { DelegatedTask, StageResult, TaskRuntimeSnapshot, TaskStatus } from "../types.js";
import { changedFiles } from "../utils/git.js";
import { ProjectMemoryStore, renderProjectMemoryMarkdown } from "../workflow/ProjectMemory.js";
import type { TaskManager } from "../workflow/TaskManager.js";
import { buildTaskResultSummary } from "../workflow/TaskResultSummary.js";
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
    const tasks = await listTasks(context);
    sendJson(response, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: summarizeTasks(tasks),
      tasks: tasks.map(taskListItem)
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/project-memory") {
    const workspace = url.searchParams.get("workspace") ?? "";
    if (!workspace) {
      sendJson(response, 400, { ok: false, error: "workspace is required" });
      return;
    }
    const store = new ProjectMemoryStore(workspace);
    const memory = await store.read();
    sendJson(response, 200, {
      ok: true,
      ...memory,
      jsonPath: store.jsonPath,
      markdownPath: store.markdownPath,
      markdown: renderProjectMemoryMarkdown(memory)
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
  if (request.method === "GET" && url.pathname === "/api/teams") {
    if (!context.taskTools) {
      sendJson(response, 200, { ok: true, teams: [] });
      return;
    }
    const result = await context.taskTools.teamListTool();
    sendToolResult(response, result);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/team-templates") {
    if (!context.taskTools) {
      sendJson(response, 200, { ok: true, templates: [] });
      return;
    }
    const result = await context.taskTools.teamTemplatesTool();
    sendToolResult(response, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/teams/from-template") {
    if (!context.taskTools) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to live task tools." });
      return;
    }
    const result = await context.taskTools.teamCreateFromTemplateTool(await readJsonBody(request) as unknown as TeamCreateFromTemplateArgs);
    sendToolResult(response, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/teams") {
    if (!context.taskTools) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to live task tools." });
      return;
    }
    const result = await context.taskTools.teamCreateTool(await readJsonBody(request) as unknown as TeamCreateArgs);
    sendToolResult(response, result);
    return;
  }
  if (url.pathname.startsWith("/api/teams/")) {
    if (!context.taskTools) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to live task tools." });
      return;
    }
    const parts = url.pathname.slice("/api/teams/".length).split("/");
    const teamId = decodeURIComponent(parts[0] ?? "");
    if (!teamId) {
      sendJson(response, 400, { ok: false, error: "teamId is required" });
      return;
    }
    if (request.method === "GET" && parts.length === 1) {
      const result = await context.taskTools.teamStatusTool({ teamId });
      sendToolResult(response, result);
      return;
    }
    if (request.method === "POST" && parts[1] === "coordinator-run") {
      const body = await readJsonBody(request) as unknown as Omit<TeamCoordinatorRunArgs, "teamId">;
      const result = await context.taskTools.teamCoordinatorRunTool({ ...body, teamId });
      sendToolResult(response, result);
      return;
    }
    if (request.method === "POST" && parts[1] === "autonomy-run") {
      const body = await readJsonBody(request) as unknown as Omit<TeamAutonomyRunArgs, "teamId">;
      const result = await context.taskTools.teamAutonomyRunTool({ ...body, teamId });
      sendToolResult(response, result);
      return;
    }
    if (request.method === "POST" && parts[1] === "round-run") {
      const body = await readJsonBody(request) as unknown as Omit<TeamRoundRunArgs, "teamId">;
      const result = await context.taskTools.teamRoundRunTool({ ...body, teamId });
      sendToolResult(response, result);
      return;
    }
    if (request.method === "POST" && parts[1] === "messages") {
      const body = await readJsonBody(request) as unknown as Omit<TeamMessageArgs, "teamId">;
      const result = await context.taskTools.teamSendMessageTool({ ...body, teamId });
      sendToolResult(response, result);
      return;
    }
    if (request.method === "POST" && parts[1] === "tasks" && parts.length === 2) {
      const body = await readJsonBody(request) as unknown as Omit<TeamTaskCreateArgs, "teamId">;
      const result = await context.taskTools.teamTaskCreateTool({ ...body, teamId });
      sendToolResult(response, result);
      return;
    }
    if (request.method === "POST" && parts[1] === "tasks" && parts[2] && parts[3] === "start") {
      const body = await readJsonBody(request) as unknown as Omit<TeamTaskStartArgs, "teamId" | "taskId">;
      const result = await context.taskTools.teamTaskStartTool({ ...body, teamId, taskId: decodeURIComponent(parts[2]) });
      sendToolResult(response, result);
      return;
    }
    if (request.method === "POST" && parts[1] === "tasks" && parts[2]) {
      const body = await readJsonBody(request) as unknown as Omit<TeamTaskUpdateArgs, "teamId" | "taskId">;
      const result = await context.taskTools.teamTaskUpdateTool({ ...body, teamId, taskId: decodeURIComponent(parts[2]) });
      sendToolResult(response, result);
      return;
    }
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
  if (request.method === "POST" && url.pathname === "/api/task-preview") {
    if (!context.taskTools) {
      sendJson(response, 409, { ok: false, error: "Dashboard is not attached to live task tools." });
      return;
    }
    const result = await context.taskTools.taskPreviewTool(await readJsonBody(request) as unknown as TaskPreviewArgs);
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
    if (request.method === "POST" && parts[1] === "rollback") {
      if (!context.taskManager) {
        sendJson(response, 409, { ok: false, error: "Dashboard is not attached to a live TaskManager." });
        return;
      }
      const task = await context.taskManager.rollback(taskId);
      if (!task) {
        sendJson(response, 404, { ok: false, error: `Task not found or cannot be rolled back: ${taskId}` });
        return;
      }
      sendJson(response, task.rollback?.status === "failed" ? 400 : 200, { ok: task.rollback?.status !== "failed", taskId: task.id, task, error: task.rollback?.error });
      return;
    }
    if (request.method !== "GET" || parts.length !== 1) {
      sendJson(response, 404, { ok: false, error: "Not found" });
      return;
    }
    const task = getRawTask(context, taskId);
    if (!task) {
      sendJson(response, 404, { ok: false, error: `Task not found: ${taskId}` });
      return;
    }
    const related = await relatedTasks(context, task);
    const summarizedTask = await withDashboardRuntime(task, related);
    const output = await readBackgroundOutput(summarizedTask, context.maxBytes, Number(url.searchParams.get("cursor") ?? 0), id => getRawTask(context, id));
    sendJson(response, 200, { ok: true, task: summarizedTask, relatedTasks: related, output });
    return;
  }

  sendJson(response, 404, { ok: false, error: "Not found" });
}

async function listTasks(context: { taskStore: TaskStore; taskManager?: TaskManager }): Promise<DelegatedTask[]> {
  const tasks = context.taskManager ? context.taskManager.list() : context.taskStore.list();
  return await Promise.all(tasks.map(task => withDashboardRuntime(task)));
}

function getRawTask(context: { taskStore: TaskStore; taskManager?: TaskManager }, taskId: string): DelegatedTask | undefined {
  return context.taskManager ? context.taskManager.get(taskId) : context.taskStore.get(taskId);
}

async function relatedTasks(context: { taskStore: TaskStore; taskManager?: TaskManager }, task: DelegatedTask): Promise<DelegatedTask[]> {
  const ids = [...(task.childTaskIds ?? [])];
  if (task.reviewTaskId && !ids.includes(task.reviewTaskId)) ids.push(task.reviewTaskId);
  const tasks = ids.map(id => getRawTask(context, id)).filter((child): child is DelegatedTask => child !== undefined);
  return await Promise.all(tasks.map(child => withDashboardRuntime(child)));
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
    durationMs: task.runtime?.durationMs ?? (Number.isFinite(created) && Number.isFinite(updated) ? Math.max(0, updated - created) : 0)
  };
}

async function withDashboardRuntime(task: DelegatedTask, relatedTasks: DelegatedTask[] = []): Promise<DelegatedTask> {
  const runtime = await buildRuntimeSnapshot(task, relatedTasks);
  const resultSummary = task.resultSummary ?? buildTaskResultSummary(task, relatedTasks);
  const active = isActive(task);
  return {
    ...task,
    runtime,
    resultSummary: active
      ? {
          ...resultSummary,
          durationMs: runtime.durationMs,
          changedFiles: unique([...resultSummary.changedFiles, ...runtime.liveChangedFiles]),
          summary: liveResultSummary(task, runtime, resultSummary.summary)
        }
      : resultSummary,
    rollback: task.rollback ?? rollbackStateFor(task)
  };
}

async function buildRuntimeSnapshot(task: DelegatedTask, relatedTasks: DelegatedTask[] = []): Promise<TaskRuntimeSnapshot> {
  const outputFiles = await runtimeOutputFiles([task, ...relatedTasks]);
  const lastOutput = outputFiles.reduce<{ time: number; value?: string }>((latest, file) => {
    if (!file.modifiedAt) return latest;
    const time = Date.parse(file.modifiedAt);
    return Number.isFinite(time) && time > latest.time ? { time, value: file.modifiedAt } : latest;
  }, { time: 0 });
  return {
    durationMs: taskDurationMs(task),
    outputBytes: outputFiles.reduce((total, file) => total + file.bytes, 0),
    outputFiles,
    lastOutputAt: lastOutput.value,
    liveChangedFiles: await liveChangedFiles(task)
  };
}

async function runtimeOutputFiles(tasks: DelegatedTask[]): Promise<TaskRuntimeSnapshot["outputFiles"]> {
  const paths = unique(tasks.flatMap(task => artifactPaths(task)));
  const files = await Promise.all(paths.map(async (path): Promise<TaskRuntimeSnapshot["outputFiles"][number] | undefined> => {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0) return undefined;
      return { path, bytes: info.size, modifiedAt: info.mtime.toISOString() };
    } catch {
      return undefined;
    }
  }));
  return files.filter((file): file is TaskRuntimeSnapshot["outputFiles"][number] => file !== undefined);
}

async function liveChangedFiles(task: DelegatedTask): Promise<string[]> {
  if (isActive(task)) return await changedFiles(task.workspace).catch(() => []);
  return task.resultSummary?.changedFiles ?? stageResults(task).flatMap(result => result.changedFiles ?? []);
}

function taskDurationMs(task: DelegatedTask): number {
  const created = Date.parse(task.createdAt);
  if (!Number.isFinite(created)) return 0;
  const end = isActive(task) ? Date.now() : Date.parse(task.updatedAt);
  return Number.isFinite(end) ? Math.max(0, end - created) : 0;
}

function liveResultSummary(task: DelegatedTask, runtime: TaskRuntimeSnapshot, fallback: string): string {
  const parts = [
    `${task.status === "pending" ? "Task is pending" : "Task is running"}`,
    `runtime ${formatDuration(runtime.durationMs)}`,
    runtime.outputBytes > 0 ? `output ${formatBytes(runtime.outputBytes)}` : undefined,
    runtime.lastOutputAt ? `last output ${runtime.lastOutputAt}` : undefined,
    runtime.liveChangedFiles.length > 0 ? `${runtime.liveChangedFiles.length} live file changes` : undefined
  ].filter((part): part is string => part !== undefined);
  return parts.length > 1 ? `${parts.join(", ")}.` : fallback;
}

function stageResults(task: DelegatedTask): StageResult[] {
  const maybeResults = (task.result as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(maybeResults)) return [];
  return maybeResults.filter((result): result is StageResult => {
    return typeof result === "object" && result !== null && typeof (result as StageResult).stage === "string";
  });
}

function isActive(task: DelegatedTask): boolean {
  return task.status === "running" || task.status === "pending";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function rollbackStateFor(task: DelegatedTask): DelegatedTask["rollback"] {
  if (!task.gitCheckpoint?.supported) return task.rollback;
  if (!task.gitCheckpoint.clean) return { status: "not_available", error: "Git checkpoint started dirty." };
  if (!task.gitDiff || task.gitDiff.files.length === 0) return { status: "not_available", error: "No task diff is available." };
  return { status: "ready" };
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
          <label>Agent<select id="workflow-agent" name="preferredAgent"><option value="">Auto</option><option value="claude">Claude</option><option value="codex-cli">Codex CLI</option><option value="gemini">Gemini</option><option value="opencode">OpenCode</option><option value="myflicker">MyFlicker</option><option value="codex">Codex handoff</option></select></label>
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
    <section class="task-preview" id="task-preview" hidden>
      <div class="panel-head">
        <h2>Execution preview</h2>
        <span class="meta" id="task-preview-status">Waiting for request</span>
      </div>
      <div id="task-preview-content" class="preview-content"></div>
    </section>
    <section class="quick-start" id="quick-start" hidden>
      <div class="panel-head">
        <h2>Quick start</h2>
        <span class="meta">Pick a common workflow</span>
      </div>
      <ol class="quick-steps">
        <li><strong>Workspace</strong><span>Use an absolute project path.</span></li>
        <li><strong>Request</strong><span>Describe the outcome, not the internal tool.</span></li>
        <li><strong>Run</strong><span>Open the created task to watch progress.</span></li>
      </ol>
      <div class="quick-start-grid" id="quick-start-examples">
        <button class="quick-start-card" type="button" data-quick-start="understand">
          <strong>Understand a project</strong>
          <span>Read code and produce a detailed project summary.</span>
        </button>
        <button class="quick-start-card" type="button" data-quick-start="feature">
          <strong>Build a feature</strong>
          <span>Plan, implement, verify, and report changed files.</span>
        </button>
        <button class="quick-start-card" type="button" data-quick-start="bugfix">
          <strong>Fix a bug</strong>
          <span>Reproduce, patch, test, and explain the root cause.</span>
        </button>
        <button class="quick-start-card" type="button" data-quick-start="long">
          <strong>Large multi-agent task</strong>
          <span>Split work into plan units and coordinate agents.</span>
        </button>
      </div>
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
          <label>Providers<input id="stability-providers" value="claude,codex-cli,gemini,myflicker" placeholder="claude,codex-cli,gemini,myflicker"></label>
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
    <section class="team-panel advanced-only" id="team-panel" hidden>
      <div class="panel-head">
        <h2>Team Mode</h2>
        <span class="meta">Shared agent messages and task board</span>
      </div>
      <div class="team-control-grid">
        <form id="team-form" class="workflow-form team-control-card">
          <div class="panel-head">
            <h3>Create team</h3>
            <span class="meta">Template sets members and starter tasks</span>
          </div>
          <div class="form-row">
            <label>Workspace<input id="team-workspace" placeholder="/absolute/path/to/project" required></label>
            <label>Lead<input id="team-lead" value="lead" placeholder="lead"></label>
            <label>Template<select id="team-template"><option value="">Custom team</option></select></label>
          </div>
          <div class="form-row">
            <label>Members<input id="team-members" value="planner:claude,coder:claude,reviewer:codex-cli" placeholder="planner:claude,coder:claude"></label>
            <label>Max running<input id="team-max-running" type="number" min="1" step="1" placeholder="template default"></label>
            <label>Max tasks<input id="team-max-tasks" type="number" min="1" step="1" placeholder="template default"></label>
          </div>
          <label class="request-field">Goal<textarea id="team-goal" rows="2" placeholder="Describe the team goal" required></textarea></label>
          <div class="team-options">
            <label title="Start eligible tasks immediately after creating from a template."><input id="team-auto-start" type="checkbox">Auto start</label>
            <label title="Create a merger task after base tasks finish."><input id="team-auto-merge" type="checkbox" checked>Auto merge</label>
          </div>
          <div class="form-actions">
            <button id="team-submit" type="submit">Create team</button>
            <span id="team-status" class="form-status"></span>
          </div>
        </form>
        <section class="team-control-card" id="team-round-panel">
          <div class="panel-head">
            <h3>Team round</h3>
            <span id="team-selected-summary" class="meta">No team selected</span>
          </div>
          <label class="request-field">Round topic<textarea id="team-round-topic" rows="3" placeholder="Align on plan, risks, blockers, or next tasks"></textarea></label>
          <div class="team-options">
            <label title="Call each member's configured provider for a read-only response."><input id="team-round-live-agents" type="checkbox">Live agents</label>
            <label title="Create follow-up tasks from round messages."><input id="team-round-create-tasks" type="checkbox">Create tasks</label>
          </div>
          <div class="form-actions">
            <button id="team-round-submit" type="button" disabled>Run round</button>
            <span id="team-round-status" class="form-status"></span>
          </div>
        </section>
      </div>
      <div class="team-layout">
        <div id="teams" class="team-list"></div>
        <div id="team-detail" class="team-detail"><span class="meta">Select a team to inspect members, messages, and shared tasks.</span></div>
      </div>
    </section>
    <section class="metrics" id="metrics"></section>
    <section class="workspace">
      <aside class="task-list" aria-label="Tasks">
        <div class="list-head">
          <h2>Tasks</h2>
          <div class="task-list-controls">
            <label class="child-toggle" for="show-child-tasks"><input id="show-child-tasks" type="checkbox">Show child tasks</label>
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
.catalog, .providers, .stability, .task-preview, .quick-start, .team-panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; display: grid; gap: 10px; }
.task-preview { align-content: start; }
.quick-start { align-content: start; }
.quick-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.quick-steps li { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px; align-items: baseline; border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: #f8fafc; }
.quick-steps strong { font-size: 12px; color: var(--text); }
.quick-steps span { color: var(--muted); font-size: 12px; line-height: 1.4; }
.quick-start-grid { display: grid; gap: 8px; }
.quick-start-card { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fff; color: var(--text); cursor: pointer; text-align: left; display: grid; gap: 4px; }
.quick-start-card:hover { border-color: var(--accent); background: #f0fdfa; }
.quick-start-card strong { font-size: 13px; }
.quick-start-card span { color: var(--muted); font-size: 12px; line-height: 1.4; }
.preview-content { display: grid; gap: 10px; }
.preview-risk { display: inline-flex; width: fit-content; border-radius: 999px; padding: 4px 8px; font-size: 12px; font-weight: 700; text-transform: capitalize; background: #eef2f7; color: var(--muted); }
.preview-risk.low { background: #dcfce7; color: var(--ok); }
.preview-risk.medium { background: #fef3c7; color: var(--warn); }
.preview-risk.high { background: #fee2e2; color: var(--danger); }
.preview-step-list, .preview-warning-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.preview-step, .preview-warning { border: 1px solid var(--line); border-radius: 6px; padding: 8px; display: grid; gap: 3px; min-width: 0; }
.preview-step { background: #f8fafc; }
.preview-warning.error { border-color: #fecaca; background: #fff5f5; }
.preview-warning.warning { border-color: #fde68a; background: #fffbeb; }
.preview-warning.info { border-color: #bfdbfe; background: #eff6ff; }
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
.task-list-controls { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; }
.child-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; cursor: pointer; }
.child-toggle input { width: 14px; height: 14px; margin: 0; accent-color: var(--accent); }
select { border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text); padding: 6px 8px; max-width: 160px; }
.tasks { overflow-y: auto; overflow-x: hidden; }
.task-row { width: 100%; min-width: 0; text-align: left; border: 0; border-bottom: 1px solid var(--line); background: #fff; padding: 12px 14px; cursor: pointer; display: grid; gap: 7px; }
.task-row:hover, .task-row.active { background: #f0fdfa; }
.task-row.child-task { border-left: 3px solid #cbd5e1; padding-left: 11px; }
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
.user-progress-panel { display: grid; gap: 12px; }
.progress-overview { display: grid; grid-template-columns: repeat(5, minmax(92px, 1fr)); gap: 8px; }
.progress-card { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #f8fafc; display: grid; gap: 4px; }
.progress-card span { color: var(--muted); font-size: 12px; font-weight: 650; text-transform: uppercase; }
.progress-card strong { font-size: 22px; color: var(--text); }
.plan-unit-list { display: grid; gap: 8px; }
.plan-unit { border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: grid; grid-template-columns: 108px minmax(0, 1fr) auto; gap: 10px; align-items: start; background: #fff; min-width: 0; }
.plan-unit.completed { border-color: #bbf7d0; background: #f7fef9; }
.plan-unit.running { border-color: #bae6fd; background: #f0f9ff; }
.plan-unit.failed, .plan-unit.interrupted { border-color: #fecaca; background: #fff7f7; }
.plan-unit-label { color: var(--muted); font-weight: 700; font-size: 12px; text-transform: uppercase; overflow-wrap: anywhere; }
.plan-unit-main { display: grid; gap: 4px; min-width: 0; }
.plan-unit-title { font-weight: 700; overflow-wrap: anywhere; }
.plan-unit-meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.debug-details > summary { cursor: pointer; font-weight: 700; display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.debug-details[open] > summary { margin-bottom: 10px; }
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
.workflow-steps { list-style: none; padding: 0; margin: 10px 0 0; display: grid; gap: 8px; }
.workflow-step { display: grid; grid-template-columns: 88px minmax(120px, 260px) minmax(0, 1fr); gap: 10px; align-items: start; border-top: 1px solid var(--line); padding-top: 8px; min-width: 0; font-size: 13px; }
.workflow-step:first-child { border-top: 0; padding-top: 0; }
.workflow-step-status { justify-self: start; white-space: nowrap; }
.workflow-step-id { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; min-width: 0; }
.workflow-step-body { line-height: 1.45; overflow-wrap: anywhere; min-width: 0; }
.workflow-step-empty { color: var(--muted); font-size: 13px; }
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
.team-control-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.75fr); gap: 12px; align-items: stretch; margin-bottom: 12px; }
.team-control-card { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 12px; min-width: 0; display: grid; gap: 10px; }
.team-control-card.workflow-form { margin: 0; }
.team-control-card .panel-head { margin-bottom: 0; }
.team-layout { display: grid; grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); gap: 12px; min-width: 0; }
.team-options { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.team-options label { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; font-weight: 650; }
.team-options input { width: 14px; height: 14px; accent-color: var(--accent); }
.team-list, .team-detail { min-width: 0; }
.team-list { display: grid; gap: 8px; align-content: start; }
.team-row { width: 100%; text-align: left; border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 10px; cursor: pointer; display: grid; gap: 5px; }
.team-row:hover, .team-row.active { border-color: var(--accent); background: #f0fdfa; }
.team-detail { border: 1px solid var(--line); border-radius: 8px; background: #f8fafc; padding: 12px; display: grid; gap: 12px; }
.team-section { display: grid; gap: 8px; }
.team-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.team-card, .team-message, .team-task, .team-conflict, .team-memory { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 9px; display: grid; gap: 4px; min-width: 0; }
.team-coordinator { border: 1px solid #dbeafe; border-radius: 8px; background: #f8fbff; padding: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.conflict-panel { border-color: #fecaca; background: #fff7f7; padding: 8px; border-radius: 8px; }
.team-round { border: 1px solid var(--line); border-radius: 8px; background: #f8fafc; padding: 9px; display: grid; gap: 8px; }
.team-message.compact { background: #fff; padding: 7px; }
.team-task.done { border-color: #bbf7d0; background: #f7fef9; }
.team-task.in_progress { border-color: #bae6fd; background: #f0f9ff; }
.team-task.blocked, .team-task.cancelled { border-color: #fecaca; background: #fff7f7; }
.linked-task-chip { border: 1px solid #dbeafe; border-radius: 6px; background: #f8fbff; padding: 7px; display: grid; gap: 4px; }
.team-task-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.team-message-list, .team-task-list, .team-memory-list { display: grid; gap: 8px; max-height: 260px; overflow: auto; }
.team-section .team-round + .team-round { margin-top: 8px; }
.team-inline-form { display: grid; grid-template-columns: 120px minmax(0, 1fr) auto; gap: 8px; align-items: end; }
.team-inline-form input, .team-inline-form textarea, .team-inline-form select { border: 1px solid var(--line); border-radius: 6px; padding: 7px; min-width: 0; }
.team-inline-form textarea { resize: vertical; min-height: 38px; }
@media (max-width: 900px) {
  .shell { padding: 12px; }
  .form-row { grid-template-columns: 1fr; }
  .catalog-grid { grid-template-columns: 1fr; }
  .provider-grid { grid-template-columns: 1fr; }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workspace { grid-template-columns: 1fr; grid-template-rows: 360px minmax(420px, 1fr); }
  .detail-grid { grid-template-columns: 1fr; }
  .progress-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .plan-unit { grid-template-columns: 1fr; }
  .workflow-step { grid-template-columns: 88px minmax(0, 1fr); }
  .workflow-step-body { grid-column: 1 / -1; }
  .team-control-grid, .team-layout, .team-inline-form { grid-template-columns: 1fr; }
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
.new-task, .providers, .task-preview, .catalog, .team-panel, .metric, .task-list, .panel { border-color: var(--line); box-shadow: var(--shadow); }
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
.providers, .task-preview { align-content: start; border-radius: 8px; }
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
.result-summary-panel { border-color: #99f6e4; background: #f0fdfa; }
.result-lede { font-size: 14px; line-height: 1.5; margin-bottom: 10px; }
.result-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 12px; }
.result-block { margin-top: 10px; }
.guardrail-list { display: grid; gap: 8px; margin-top: 8px; }
.guardrail-item { border: 1px solid #fde68a; border-radius: 6px; background: #fffbeb; padding: 8px 10px; display: grid; gap: 3px; }
.guardrail-item.error { border-color: #fecaca; background: #fff5f5; }
.guardrail-item.warning { border-color: #fde68a; background: #fffbeb; }
.project-memory-panel { border-color: #bae6fd; background: #f8fcff; }
.memory-list { display: grid; gap: 8px; margin-top: 10px; }
.memory-entry { border: 1px solid #dbeafe; background: #ffffff; border-radius: 6px; padding: 8px 10px; display: grid; gap: 4px; }
.memory-entry strong { font-size: 13px; }
.runtime-panel { border-color: #bfdbfe; background: #f8fbff; }
.runtime-line { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.runtime-line strong { color: var(--text); font-size: 12px; }
.runtime-file-list { display: grid; gap: 6px; margin-top: 8px; }
.runtime-file { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: baseline; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 8px; background: #fff; font-size: 12px; }
.runtime-file span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .list-head { align-items: stretch; flex-direction: column; }
  .task-list-controls { justify-content: space-between; }
}`;

const DASHBOARD_JS = `const SIMPLE_COMMANDS = ["ultrawork", "start-work", "plan-work", "review-work", "explore"];
const SIMPLE_COMMAND_SET = new Set(SIMPLE_COMMANDS);
const QUICK_START_EXAMPLES = {
  understand: {
    command: "/ultrawork",
    agent: "",
    request: "Read this existing project and produce a detailed README-style explanation: purpose, tech stack, directory structure, core modules, startup flow, test flow, important configuration files, and key risks. Include concrete file paths and line references where useful. Do not modify files.",
    verifyCommand: ""
  },
  feature: {
    command: "/ultrawork",
    agent: "",
    request: "Implement this feature end to end. Create a plan first, split work when useful, modify the code, run relevant verification, and provide a final report with changed files and test results.",
    verifyCommand: ""
  },
  bugfix: {
    command: "/ultrawork",
    agent: "",
    request: "Fix this bug. First inspect the current behavior and likely root cause, then make the smallest safe code change, run verification, and summarize the root cause, patch, and remaining risks.",
    verifyCommand: ""
  },
  long: {
    command: "/ultrawork",
    agent: "",
    request: "Run this as a larger multi-agent workflow. Break the requirement into plan units, execute independent work in parallel where safe, review the result, repair failures automatically when verification is non-idempotent or flaky, and produce a final delivery report.",
    verifyCommand: ""
  }
};

const state = { tasks: [], teams: [], teamTemplates: [], commands: [], stabilityRuns: [], projectMemoryByWorkspace: {}, mode: "simple", selectedTaskId: undefined, selectedTeamId: undefined, filter: "", showChildren: false, selectedIoTab: undefined, lastPreview: undefined, capabilities: { liveTaskManager: false, liveTaskTools: false, liveStabilityRunner: false } };

const els = {
  workflowPanel: document.getElementById("workflow-panel"),
  quickStart: document.getElementById("quick-start"),
  quickStartExamples: document.getElementById("quick-start-examples"),
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
  teamPanel: document.getElementById("team-panel"),
  teamForm: document.getElementById("team-form"),
  teamWorkspace: document.getElementById("team-workspace"),
  teamGoal: document.getElementById("team-goal"),
  teamLead: document.getElementById("team-lead"),
  teamTemplate: document.getElementById("team-template"),
  teamMembers: document.getElementById("team-members"),
  teamMaxRunning: document.getElementById("team-max-running"),
  teamMaxTasks: document.getElementById("team-max-tasks"),
  teamAutoStart: document.getElementById("team-auto-start"),
  teamAutoMerge: document.getElementById("team-auto-merge"),
  teamRoundTopic: document.getElementById("team-round-topic"),
  teamRoundLiveAgents: document.getElementById("team-round-live-agents"),
  teamRoundCreateTasks: document.getElementById("team-round-create-tasks"),
  teamRoundSubmit: document.getElementById("team-round-submit"),
  teamRoundStatus: document.getElementById("team-round-status"),
  teamSelectedSummary: document.getElementById("team-selected-summary"),
  teamSubmit: document.getElementById("team-submit"),
  teamStatus: document.getElementById("team-status"),
  teams: document.getElementById("teams"),
  teamDetail: document.getElementById("team-detail"),
  providers: document.getElementById("providers"),
  taskPreview: document.getElementById("task-preview"),
  taskPreviewStatus: document.getElementById("task-preview-status"),
  taskPreviewContent: document.getElementById("task-preview-content"),
  metrics: document.getElementById("metrics"),
  tasks: document.getElementById("tasks"),
  detail: document.getElementById("detail"),
  empty: document.getElementById("detail-empty"),
  updated: document.getElementById("updated"),
  refresh: document.getElementById("refresh"),
  simpleMode: document.getElementById("simple-mode"),
  advancedMode: document.getElementById("advanced-mode"),
  filter: document.getElementById("status-filter"),
  showChildren: document.getElementById("show-child-tasks"),
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
  loadTeams();
});
els.simpleMode.addEventListener("click", () => setMode("simple"));
els.advancedMode.addEventListener("click", () => setMode("advanced"));
els.filter.addEventListener("change", event => {
  state.filter = event.target.value;
  renderTasks();
});
els.showChildren.addEventListener("change", event => {
  state.showChildren = event.target.checked;
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
els.teamForm.addEventListener("submit", event => {
  event.preventDefault();
  submitTeam();
});
els.teamRoundSubmit.addEventListener("click", () => {
  if (!state.selectedTeamId) {
    els.teamRoundStatus.textContent = "Select a team first";
    return;
  }
  runTeamRound(state.selectedTeamId);
});
els.quickStartExamples.addEventListener("click", event => {
  const button = event.target.closest("[data-quick-start]");
  if (!button) return;
  applyQuickStart(button.dataset.quickStart);
});
for (const field of els.form.querySelectorAll("input, textarea, select")) {
  field.addEventListener("input", scheduleTaskPreview);
  field.addEventListener("change", scheduleTaskPreview);
}
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
  scheduleTaskPreview();
}

function workflowPayload() {
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
  return { tab, endpoint, body };
}

async function submitWorkflow() {
  const { endpoint, body } = workflowPayload();
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

let previewTimer;
function scheduleTaskPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(loadTaskPreview, 500);
}

async function loadTaskPreview() {
  if (!state.capabilities.liveTaskTools || !els.taskPreview || els.taskPreview.hidden) return;
  const { body } = workflowPayload();
  if (!body.workspace) {
    els.taskPreviewStatus.textContent = "Workspace required";
    els.taskPreviewContent.innerHTML = '<span class="meta">Enter a workspace to preview execution.</span>';
    return;
  }
  els.taskPreviewStatus.textContent = "Checking...";
  try {
    const response = await fetch("/api/task-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Preview failed");
    state.lastPreview = data.preview;
    els.taskPreviewStatus.textContent = "Ready";
    els.taskPreviewContent.innerHTML = renderTaskPreview(data.preview);
    const applyButton = els.taskPreviewContent.querySelector("[data-apply-preview]");
    if (applyButton) applyButton.addEventListener("click", applyRecommendedSetup);
  } catch (error) {
    els.taskPreviewStatus.textContent = "Unavailable";
    els.taskPreviewContent.innerHTML = '<span class="meta">' + escapeHtml(error.message || String(error)) + '</span>';
  }
}

function applyRecommendedSetup() {
  const setup = state.lastPreview?.recommendedSetup;
  if (!setup) return;
  if (setup.tab && setup.tab !== "command") setMode("advanced");
  if (setup.tab) setTab(setup.tab);
  if (setup.command && els.command) els.command.value = setup.command;
  if (setup.mode && els.mode) els.mode.value = setup.mode;
  if (setup.strategy && els.strategy) els.strategy.value = setup.strategy;
  if (setup.preferredAgent !== undefined && els.agent) els.agent.value = setup.preferredAgent;
  if (setup.stage && els.stage) els.stage.value = setup.stage;
  if (setup.profile !== undefined && els.profile) els.profile.value = setup.profile || "";
  els.formStatus.textContent = setup.requiresConfirmation
    ? "Recommended setup applied. Review warnings before running."
    : "Recommended setup applied.";
  scheduleTaskPreview();
}

function applyQuickStart(key) {
  const example = QUICK_START_EXAMPLES[key];
  if (!example) return;
  setMode("simple");
  setTab("command");
  setWorkflowCommand(example.command);
  els.agent.value = example.agent || "";
  els.request.value = example.request || "";
  els.verifyCommand.value = example.verifyCommand || "";
  els.formStatus.textContent = "Template applied. Fill workspace, adjust request, then run.";
  scheduleTaskPreview();
  els.workspace.focus();
}

function setWorkflowCommand(command) {
  if (!command) return;
  const existing = Array.from(els.command.options).some(option => option.value === command);
  if (!existing) {
    const option = document.createElement("option");
    option.value = command;
    option.textContent = command;
    els.command.appendChild(option);
  }
  els.command.value = command;
}

function renderTaskPreview(preview) {
  if (!preview) return '<span class="meta">No preview available.</span>';
  const warnings = preview.warnings || [];
  const steps = preview.executionPlan || [];
  return \`
    <span class="preview-risk \${escapeAttr(preview.risk?.level || "low")}">\${escapeHtml(preview.risk?.level || "low")} risk · \${escapeHtml(String(preview.risk?.score ?? 0))}</span>
    <div class="result-grid">
      \${kv("Strategy", preview.strategy || "")}
      \${kv("Will edit", preview.willModifyFiles ? "yes" : "no")}
      \${kv("Verification", preview.verification?.configured ? preview.verification.command || "configured" : "not configured")}
    </div>
    <div>
      <h3>Execution</h3>
      <ul class="preview-step-list">\${steps.map(step => \`
        <li class="preview-step">
          <strong>\${escapeHtml(step.role || "step")}</strong>
          <span class="meta">\${escapeHtml([step.stage, step.profile, step.provider, step.count ? "x" + step.count : ""].filter(Boolean).join(" / "))}</span>
        </li>
      \`).join("")}</ul>
    </div>
    <div>
      <h3>Warnings</h3>
      \${warnings.length > 0 ? '<ul class="preview-warning-list">' + warnings.map(warning => \`
        <li class="preview-warning \${escapeAttr(warning.severity || "info")}">
          <strong>\${escapeHtml(warning.code || "warning")} / \${escapeHtml(warning.severity || "info")}</strong>
          <span class="meta">\${escapeHtml(warning.message || "")}</span>
        </li>
      \`).join("") + '</ul>' : '<span class="meta">No blocking risks detected.</span>'}
    </div>
    <div>
      <h3>Recommended action</h3>
      <span class="meta">\${escapeHtml(preview.recommendedAction || "Run the task.")}</span>
    </div>
    \${preview.recommendedSetup ? '<button class="secondary-button" type="button" data-apply-preview>Apply recommended setup</button>' : ''}
    \${preview.recommendedSetup?.notes?.length ? '<ul class="finding-list">' + preview.recommendedSetup.notes.map(note => '<li>' + escapeHtml(note) + '</li>').join("") + '</ul>' : ''}
  \`;
}

async function loadTasks(options = {}) {
  const response = await fetch("/api/tasks");
  const data = await response.json();
  state.tasks = data.tasks || [];
  els.updated.textContent = "Updated " + new Date(data.generatedAt || Date.now()).toLocaleString();
  renderMetrics(data.summary || {});
  renderTasks();
  if (state.selectedTaskId) await loadDetail(state.selectedTaskId, { preserveViewState: options.preserveDetailView !== false });
}

async function loadCapabilities() {
  const response = await fetch("/api/capabilities");
  const data = await response.json();
  state.capabilities = data;
  els.workflowPanel.hidden = !data.liveTaskTools;
  els.quickStart.hidden = !data.liveTaskTools;
  els.taskPreview.hidden = !data.liveTaskTools;
  els.catalog.hidden = !data.liveTaskTools;
  els.providers.hidden = !data.liveTaskTools;
  els.teamPanel.hidden = !data.liveTaskTools;
  els.stabilityPanel.hidden = !data.liveStabilityRunner;
  if (data.liveTaskTools) await loadProviders();
  if (data.liveTaskTools) await loadCatalog();
  if (data.liveTaskTools) await loadCommands();
  if (data.liveTaskTools) await loadTeamTemplates();
  if (data.liveTaskTools) await loadTeams();
  if (data.liveTaskTools) scheduleTaskPreview();
  if (data.liveStabilityRunner) await loadStabilityRuns();
}

async function submitTeam() {
  const workspace = els.teamWorkspace.value.trim() || els.workspace.value.trim();
  const goal = els.teamGoal.value.trim() || els.request.value.trim();
  const lead = els.teamLead.value.trim() || "lead";
  const members = parseTeamMembers(els.teamMembers.value);
  const template = els.teamTemplate.value;
  const maxRunning = Number(els.teamMaxRunning.value);
  const maxTasks = Number(els.teamMaxTasks.value);
  const budget = {};
  if (Number.isInteger(maxRunning) && maxRunning > 0) budget.maxRunning = maxRunning;
  if (Number.isInteger(maxTasks) && maxTasks > 0) budget.maxTasks = maxTasks;
  els.teamStatus.textContent = "Creating...";
  els.teamSubmit.disabled = true;
  try {
    const response = await fetch(template ? "/api/teams/from-template" : "/api/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        goal,
        lead,
        members: template ? undefined : members,
        template: template || undefined,
        autoStart: els.teamAutoStart.checked,
        autoMerge: els.teamAutoMerge.checked,
        budget: Object.keys(budget).length > 0 ? budget : undefined
      })
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Failed to create team");
    state.selectedTeamId = data.team?.id;
    els.teamStatus.textContent = "Team " + state.selectedTeamId + " created";
    await loadTeams();
  } catch (error) {
    els.teamStatus.textContent = error.message || String(error);
  } finally {
    els.teamSubmit.disabled = false;
  }
}

async function loadTeamTemplates() {
  const response = await fetch("/api/team-templates");
  const data = await response.json();
  state.teamTemplates = data.templates || [];
  els.teamTemplate.innerHTML = '<option value="">Custom team</option>' + state.teamTemplates.map(template =>
    '<option value="' + escapeAttr(template.name) + '">' + escapeHtml(template.name) + '</option>'
  ).join("");
}

function parseTeamMembers(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .map((item, index) => {
      const [role, agentOrProfile] = item.split(":").map(part => part.trim());
      const member = { id: role || "member-" + String(index + 1), role: role || "member" };
      if (agentOrProfile && ["claude", "codex", "codex-cli", "gemini", "opencode", "myflicker"].includes(agentOrProfile)) member.agent = agentOrProfile;
      else if (agentOrProfile) member.profile = agentOrProfile;
      return member;
    });
}

async function loadTeams() {
  if (!state.capabilities.liveTaskTools) return;
  const response = await fetch("/api/teams");
  const data = await response.json();
  state.teams = data.teams || [];
  if (!state.selectedTeamId && state.teams.length > 0) state.selectedTeamId = state.teams[0].id;
  renderTeams();
  if (state.selectedTeamId) await loadTeamDetail(state.selectedTeamId);
}

function renderTeams() {
  if (!els.teams) return;
  if (state.teams.length === 0) {
    els.teams.innerHTML = '<span class="meta">No teams yet.</span>';
    els.teamDetail.innerHTML = '<span class="meta">Create a team to coordinate agent messages and shared tasks.</span>';
    renderTeamRoundSelection(undefined);
    return;
  }
  renderTeamRoundSelection(state.teams.find(team => team.id === state.selectedTeamId));
  els.teams.innerHTML = state.teams.map(team => \`
    <button class="team-row \${team.id === state.selectedTeamId ? "active" : ""}" type="button" data-team-id="\${escapeAttr(team.id)}">
      <strong>\${escapeHtml(team.goal || team.id)}</strong>
      <span class="meta">\${escapeHtml(team.workspace || "")}</span>
      <span class="meta">\${escapeHtml(String((team.members || []).length))} members / \${escapeHtml(String((team.tasks || []).length))} tasks / \${escapeHtml(String((team.messages || []).length))} messages</span>
    </button>
  \`).join("");
  for (const button of els.teams.querySelectorAll("[data-team-id]")) {
    button.addEventListener("click", () => loadTeamDetail(button.dataset.teamId));
  }
}

function renderTeamRoundSelection(team) {
  if (!els.teamRoundSubmit || !els.teamSelectedSummary) return;
  els.teamRoundSubmit.disabled = !team;
  els.teamSelectedSummary.textContent = team
    ? [team.id, String((team.members || []).length) + " members", String((team.tasks || []).length) + " tasks"].join(" / ")
    : "No team selected";
}

async function loadTeamDetail(teamId) {
  state.selectedTeamId = teamId;
  renderTeams();
  const response = await fetch("/api/teams/" + encodeURIComponent(teamId));
  const data = await response.json();
  if (!data.ok) {
    els.teamDetail.innerHTML = '<span class="meta">' + escapeHtml(data.error || "Failed to load team") + '</span>';
    return;
  }
  renderTeamDetail(data.team, data.linkedTasks || []);
}

function renderTeamDetail(team, linkedTasks) {
  const members = team.members || [];
  const messages = team.messages || [];
  const tasks = team.tasks || [];
  const linkedTaskById = new Map((linkedTasks || []).map(task => [task.id, task]));
  els.teamDetail.innerHTML = \`
    <div class="team-section">
      <div class="panel-head"><h3>\${escapeHtml(team.id)}</h3><span class="meta">\${escapeHtml(team.updatedAt || "")}</span></div>
      \${kv("Goal", team.goal || "")}
      \${kv("Workspace", team.workspace || "")}
      \${kv("Lead", team.lead || "")}
      \${kv("Template", team.template || "")}
      \${renderTeamBudget(team.budget)}
      \${renderTeamCoordinator(team)}
    </div>
    \${renderTeamConflicts(team.conflicts || [])}
    \${renderTeamMemory(team.memory || [], members)}
    <div class="team-section">
      <h3>Collaboration timeline</h3>
      \${renderTeamTimeline(messages)}
    </div>
    <div class="team-section">
      <h3>Members</h3>
      <div class="team-card-grid">\${members.map(member => \`
        <div class="team-card">
          <strong>\${escapeHtml(member.id || member.role)}</strong>
          <span class="meta">\${escapeHtml([member.role, member.profile, member.agent, member.status].filter(Boolean).join(" / "))}</span>
          \${member.summary ? '<span class="meta">' + escapeHtml(member.summary) + '</span>' : ''}
          \${member.memory?.length ? '<span class="meta">memory ' + escapeHtml(String(member.memory.length)) + '</span>' : ''}
        </div>
      \`).join("") || '<span class="meta">No members.</span>'}</div>
    </div>
    <div class="team-section">
      <h3>Messages</h3>
      <form class="team-inline-form" data-team-message-form>
        <select name="from">\${members.map(member => '<option value="' + escapeAttr(member.id) + '">' + escapeHtml(member.id) + '</option>').join("")}<option value="lead">lead</option></select>
        <textarea name="body" placeholder="Message to the team"></textarea>
        <button class="secondary-button" type="submit">Send</button>
      </form>
      <div class="team-message-list">\${messages.slice().reverse().slice(0, 20).map(message => \`
        <div class="team-message">
          <strong>\${escapeHtml(message.from)} → \${escapeHtml(message.to || "all")}</strong>
          <span>\${escapeHtml(message.body || "")}</span>
          <span class="meta">\${escapeHtml(message.createdAt || "")}\${message.taskId ? " / " + escapeHtml(message.taskId) : ""}</span>
        </div>
      \`).join("") || '<span class="meta">No messages.</span>'}</div>
    </div>
    <div class="team-section">
      <h3>Shared tasks</h3>
      <form class="team-inline-form" data-team-task-form>
        <select name="assignee"><option value="">Unassigned</option>\${members.map(member => '<option value="' + escapeAttr(member.id) + '">' + escapeHtml(member.id) + '</option>').join("")}</select>
        <input name="title" placeholder="Task title">
        <button class="secondary-button" type="submit">Add task</button>
      </form>
      <div class="team-task-list">\${tasks.map(task => \`
        <div class="team-task \${escapeAttr(task.status || "")}">
          <div class="panel-head"><strong>\${escapeHtml(task.title || task.id)}</strong><span class="status \${escapeAttr(task.status || "")}">\${escapeHtml(task.status || "todo")}</span></div>
          <span class="meta">\${escapeHtml([task.assignee ? "@" + task.assignee : "", task.linkedTaskId ? "linked " + task.linkedTaskId : ""].filter(Boolean).join(" / "))}</span>
          \${renderLinkedTeamTask(linkedTaskById.get(task.linkedTaskId))}
          \${task.description ? '<span>' + escapeHtml(task.description) + '</span>' : ''}
          <div class="team-task-actions">
            \${task.linkedTaskId ? '<button class="secondary-button" type="button" data-open-linked-task="' + escapeAttr(task.linkedTaskId) + '">Open linked task</button>' : '<button class="secondary-button" type="button" data-start-team-task="' + escapeAttr(task.id) + '">Start agent</button>'}
          </div>
        </div>
      \`).join("") || '<span class="meta">No shared tasks.</span>'}</div>
    </div>
  \`;
  const messageForm = els.teamDetail.querySelector("[data-team-message-form]");
  if (messageForm) messageForm.addEventListener("submit", event => submitTeamMessage(event, team.id));
  const taskForm = els.teamDetail.querySelector("[data-team-task-form]");
  if (taskForm) taskForm.addEventListener("submit", event => submitTeamTask(event, team.id));
  const coordinatorButton = els.teamDetail.querySelector("[data-run-team-coordinator]");
  if (coordinatorButton) coordinatorButton.addEventListener("click", () => runTeamCoordinator(team.id));
  const roundButton = els.teamDetail.querySelector("[data-run-team-round]");
  if (roundButton) roundButton.addEventListener("click", () => runTeamRound(team.id));
  const autonomyButton = els.teamDetail.querySelector("[data-run-team-autonomy]");
  if (autonomyButton) autonomyButton.addEventListener("click", () => runTeamAutonomy(team.id));
  for (const button of els.teamDetail.querySelectorAll("[data-start-team-task]")) {
    button.addEventListener("click", () => startTeamTask(team.id, button.dataset.startTeamTask));
  }
  for (const button of els.teamDetail.querySelectorAll("[data-open-linked-task]")) {
    button.addEventListener("click", () => loadDetail(button.dataset.openLinkedTask));
  }
}

function renderTeamBudget(budget) {
  if (!budget) return "";
  return kv("Budget", [
    budget.maxRunning ? "running " + budget.maxRunning : "",
    budget.maxTasks ? "tasks " + budget.maxTasks : "",
    budget.maxRuntimeMs ? "runtime " + formatDuration(budget.maxRuntimeMs) : "",
    budget.maxRepairAttempts !== undefined ? "repairs " + budget.maxRepairAttempts : "",
    budget.allowedAgents?.length ? "agents " + budget.allowedAgents.join(", ") : ""
  ].filter(Boolean).join(" / "));
}

function renderTeamCoordinator(team) {
  const coordinator = team.coordinator || {};
  return \`
    <div class="team-coordinator">
      <span class="status \${escapeAttr(coordinator.phase || "idle")}">\${escapeHtml(coordinator.phase || "idle")}</span>
      <span class="meta">\${escapeHtml([coordinator.autoStart ? "auto-start" : "", coordinator.autoMerge ? "auto-merge" : "", coordinator.lastAction || ""].filter(Boolean).join(" / "))}</span>
      <button class="secondary-button" type="button" data-run-team-coordinator>Run coordinator</button>
      <button class="secondary-button" type="button" data-run-team-round>Run team round</button>
      <button class="secondary-button" type="button" data-run-team-autonomy>Run autonomy loop</button>
    </div>
  \`;
}

function renderTeamConflicts(conflicts) {
  const open = conflicts.filter(conflict => conflict.status === "open");
  if (!open.length) return "";
  return \`
    <div class="team-section conflict-panel">
      <h3>Open conflicts</h3>
      \${open.map(conflict => \`
        <div class="team-conflict">
          <strong>\${escapeHtml(conflict.file)}</strong>
          <span class="meta">\${escapeHtml([conflict.teamTaskIds?.join(", "), conflict.taskIds?.join(", "), conflict.arbitrationTaskId ? "arbitrate " + conflict.arbitrationTaskId : ""].filter(Boolean).join(" / "))}</span>
        </div>
      \`).join("")}
    </div>
  \`;
}

function renderTeamMemory(memory, members) {
  const latest = memory.slice().reverse().slice(0, 8);
  if (!latest.length && !members.some(member => member.memory?.length)) return "";
  return \`
    <div class="team-section">
      <h3>Team memory</h3>
      <div class="team-memory-list">\${latest.map(item => \`
        <div class="team-memory">
          <strong>\${escapeHtml(item.scope === "member" && item.memberId ? item.memberId : "team")}</strong>
          <span>\${escapeHtml(item.body || "")}</span>
          <span class="meta">\${escapeHtml(item.createdAt || "")}</span>
        </div>
      \`).join("") || '<span class="meta">No memory yet.</span>'}</div>
    </div>
  \`;
}

function renderTeamTimeline(messages) {
  if (!messages.length) return '<span class="meta">No collaboration rounds yet.</span>';
  const groups = new Map();
  for (const message of messages) {
    const key = message.roundId || "manual";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  return Array.from(groups.entries()).reverse().slice(0, 8).map(([roundId, items]) => \`
    <div class="team-round">
      <div class="panel-head"><strong>\${escapeHtml(roundId === "manual" ? "Manual messages" : roundId)}</strong><span class="meta">\${escapeHtml(String(items.length))} messages</span></div>
      \${items.slice().reverse().map(message => \`
        <div class="team-message compact">
          <strong>\${escapeHtml(message.from)} → \${escapeHtml(message.to || "all")}</strong>
          <span>\${escapeHtml(message.body || "")}</span>
        </div>
      \`).join("")}
    </div>
  \`).join("");
}

async function runTeamCoordinator(teamId) {
  const response = await fetch("/api/teams/" + encodeURIComponent(teamId) + "/coordinator-run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autoStart: true, autoMerge: true })
  });
  const data = await response.json();
  if (!data.ok) {
    alert(data.error || "Failed to run team coordinator");
    return;
  }
  await loadTeams();
  await loadTasks();
}

async function runTeamAutonomy(teamId) {
  const response = await fetch("/api/teams/" + encodeURIComponent(teamId) + "/autonomy-run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cycles: 3, liveAgents: true, createTasks: false, autoStart: true, autoMerge: true })
  });
  const data = await response.json();
  if (!data.ok) {
    alert(data.error || "Failed to run team autonomy loop");
    return;
  }
  await loadTeams();
  await loadTasks();
}

async function runTeamRound(teamId) {
  const topic = els.teamRoundTopic.value.trim();
  els.teamRoundStatus.textContent = els.teamRoundLiveAgents.checked ? "Running live agents..." : "Running round...";
  els.teamRoundSubmit.disabled = true;
  try {
    const response = await fetch("/api/teams/" + encodeURIComponent(teamId) + "/round-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: topic || undefined,
        liveAgents: els.teamRoundLiveAgents.checked,
        createTasks: els.teamRoundCreateTasks.checked
      })
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Failed to run team round");
    const generated = data.round?.generatedTasks?.length || 0;
    els.teamRoundStatus.textContent = generated ? "Round complete, tasks created: " + generated : "Round complete";
    await loadTeams();
  } catch (error) {
    els.teamRoundStatus.textContent = error.message || String(error);
  } finally {
    const team = state.teams.find(item => item.id === teamId);
    els.teamRoundSubmit.disabled = !team;
  }
}

function renderLinkedTeamTask(task) {
  if (!task) return "";
  const summary = task.resultSummary?.summary || "";
  const runtime = task.runtime?.durationMs ? formatDuration(task.runtime.durationMs) : "";
  return \`
    <div class="linked-task-chip">
      <span class="status \${escapeAttr(task.status || "")}">\${escapeHtml(task.status || "unknown")}</span>
      <span class="meta">\${escapeHtml([task.preferredAgent || task.profile, runtime, task.updatedAt ? "updated " + formatTime(task.updatedAt) : ""].filter(Boolean).join(" / "))}</span>
      \${summary ? '<span class="meta">' + escapeHtml(truncateText(summary, 160)) + '</span>' : ''}
    </div>
  \`;
}

async function submitTeamMessage(event, teamId) {
  event.preventDefault();
  const form = event.currentTarget;
  const fromInput = form.querySelector("[name='from']");
  const bodyInput = form.querySelector("[name='body']");
  const body = bodyInput.value.trim();
  if (!body) return;
  const response = await fetch("/api/teams/" + encodeURIComponent(teamId) + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: fromInput.value || "lead", body })
  });
  const data = await response.json();
  if (!data.ok) alert(data.error || "Failed to send message");
  await loadTeams();
}

async function submitTeamTask(event, teamId) {
  event.preventDefault();
  const form = event.currentTarget;
  const titleInput = form.querySelector("[name='title']");
  const assigneeInput = form.querySelector("[name='assignee']");
  const title = titleInput.value.trim();
  if (!title) return;
  const response = await fetch("/api/teams/" + encodeURIComponent(teamId) + "/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, assignee: assigneeInput.value || undefined })
  });
  const data = await response.json();
  if (!data.ok) alert(data.error || "Failed to create team task");
  await loadTeams();
}

async function startTeamTask(teamId, taskId) {
  const response = await fetch("/api/teams/" + encodeURIComponent(teamId) + "/tasks/" + encodeURIComponent(taskId) + "/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "background" })
  });
  const data = await response.json();
  if (!data.ok) {
    alert(data.error || "Failed to start team task");
    return;
  }
  await loadTeams();
  await loadTasks();
  if (data.delegatedTaskId) await loadDetail(data.delegatedTaskId);
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
        \${check.requestedModel ? '<span class="meta">requested: ' + escapeHtml(check.requestedModel) + '</span>' : ''}
        \${check.model ? '<span class="meta">model: ' + escapeHtml(check.model) + '</span>' : ''}
        \${check.modelStatus ? '<span class="meta">model status: ' + escapeHtml(check.modelStatus) + '</span>' : ''}
        \${check.modelError ? '<span class="meta">' + escapeHtml(check.modelError) + '</span>' : ''}
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

function renderTaskRuntimeLine(task) {
  const runtime = task.runtime;
  if (!runtime) return "";
  const parts = [
    formatDuration(runtime.durationMs),
    runtime.outputBytes > 0 ? formatBytes(runtime.outputBytes) + " output" : "",
    runtime.lastOutputAt ? "last " + formatTime(runtime.lastOutputAt) : "",
    (runtime.liveChangedFiles || []).length > 0 ? String(runtime.liveChangedFiles.length) + " files" : ""
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return '<span class="meta runtime-line"><strong>Runtime</strong><span>' + escapeHtml(parts.join(" / ")) + '</span></span>';
}

function renderTasks() {
  const tasks = visibleTasks();
  if (tasks.length === 0) {
    const hiddenChildren = hiddenChildTaskCount();
    const message = hiddenChildren > 0 && !state.showChildren
      ? "No parent tasks match this filter. " + hiddenChildren + " child tasks hidden."
      : "No tasks match this filter.";
    els.tasks.innerHTML = '<div class="empty">' + escapeHtml(message) + '</div>';
    return;
  }
  els.tasks.innerHTML = tasks.map(task => \`
    <button class="task-row \${task.id === state.selectedTaskId ? "active" : ""} \${task.parentTaskId ? "child-task" : ""}" type="button" data-task-id="\${escapeAttr(task.id)}">
      <span class="task-title"><strong>\${escapeHtml(task.request || task.id)}</strong><span class="status \${escapeAttr(task.status)}">\${escapeHtml(displayTaskStatus(task))}</span></span>
      <span class="meta">\${escapeHtml(task.workspace)}</span>
      <span class="meta">\${escapeHtml([task.kind === "workflow" ? "workflow" : "", task.parentTaskId ? "child of " + task.parentTaskId : "", task.profile, task.category, task.preferredAgent, (task.stages || []).join(" -> ")].filter(Boolean).join(" / "))}</span>
      \${renderTaskRuntimeLine(task)}
      \${task.verification ? '<span class="meta">verify: ' + escapeHtml(task.verification.status) + (task.verification.repairTaskId ? ' / repair ' + escapeHtml(task.verification.repairTaskId) : '') + '</span>' : ''}
    </button>
  \`).join("");
  for (const button of els.tasks.querySelectorAll("[data-task-id]")) {
    button.addEventListener("click", () => loadDetail(button.dataset.taskId));
  }
}

function visibleTasks() {
  return state.tasks.filter(task => {
    if (!state.showChildren && task.parentTaskId) return false;
    if (state.filter && task.status !== state.filter) return false;
    return true;
  });
}

function hiddenChildTaskCount() {
  return state.tasks.filter(task => task.parentTaskId && (!state.filter || task.status === state.filter)).length;
}

function displayTaskStatus(task) {
  if (task?.status === "completed" && task?.verification?.status === "passed" && task?.verification?.repairTaskId) return "completed after repair";
  return task?.status || "unknown";
}

async function loadDetail(taskId, options = {}) {
  const previousViewState = options.preserveViewState && state.selectedTaskId === taskId
    ? captureDetailViewState()
    : undefined;
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
  renderDetail(data.task, data.output || {}, data.relatedTasks || [], previousViewState);
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

async function rollbackTask(taskId) {
  if (!confirm("Rollback this task's git changes? This only runs when the task checkpoint was clean.")) return;
  const response = await fetch("/api/tasks/" + encodeURIComponent(taskId) + "/rollback", { method: "POST" });
  const data = await response.json();
  if (!data.ok) {
    alert(data.error || "Rollback failed");
    await loadTasks();
    await loadDetail(taskId);
    return;
  }
  await loadTasks();
  await loadDetail(taskId);
}

function renderDetail(task, output, relatedTasks, previousViewState) {
  const summary = output.transcriptSummary;
  const plan = task.workflow?.summary ? workflowPlanSummary(task, output.planSummary) : output.planSummary;
  els.empty.hidden = true;
  els.detail.hidden = false;
  els.detail.innerHTML = \`
    \${renderRequirementProgressPanel(task, output, relatedTasks || [])}
    \${renderPlanUnitsPanel(task, output, relatedTasks || [])}
    \${renderResultSummaryPanel(task)}
    \${renderOutcomePanel(task, output)}
    \${renderProjectMemoryPanel(task)}
    \${renderVerificationPanel(task)}
    <details class="panel section debug-details advanced-only">
      <summary><span>Technical details</span><span class="meta">sessions, logs, artifacts, transcript</span></summary>
      \${renderRuntimePanel(task)}
      \${renderWorkflowMap(task, relatedTasks || [])}
      <div class="detail-grid">
        <div class="panel">
          <h3>Task metadata</h3>
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
          \${kv("Continuation of", task.continuationOf || "")}
          \${kv("Continuation task", task.continuationTaskId || "")}
          \${kv("Profile", task.profile || "")}
          \${kv("Category", task.category || "")}
          \${kv("Preferred agent", task.preferredAgent || "")}
          \${kv("Requested model", task.model || "")}
          \${kv("Effort", task.effort || "")}
          \${kv("Timeout", task.timeoutMs ? String(task.timeoutMs) + "ms" : "")}
          \${kv("Verify command", task.verifyCommand || "")}
          \${kv("Repair attempt", task.repairAttempt !== undefined ? String(task.repairAttempt) : "")}
          \${kv("Max repairs", task.maxRepairAttempts !== undefined ? String(task.maxRepairAttempts) : "")}
          \${kv("Continuation attempt", task.continuationAttempt !== undefined ? String(task.continuationAttempt) : "")}
          \${kv("Max continuations", task.maxContinuationAttempts !== undefined ? String(task.maxContinuationAttempts) : "")}
          \${kv("Skills", (task.skills || []).map(skill => skill.name).join(", "))}
        </div>
        <div class="panel">
          <h3>Agent</h3>
          \${kv("Session", summary?.sessionId || task.agentSessionId || "")}
          \${kv("Actual models", (summary?.models || []).join(", "))}
          \${kv("Tool calls", String(summary?.toolCalls?.length || 0))}
          \${kv("Tokens", summary ? String(summary.usage.inputTokens + summary.usage.outputTokens) : "")}
        </div>
      </div>
      \${renderWorkflowStatePanel(task)}
      \${plan ? renderPlanSummary(plan) : ''}
      \${renderDiffPanel(task)}
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
    </details>
  \`;
  const cancelButton = els.detail.querySelector("[data-cancel-task]");
  if (cancelButton) cancelButton.addEventListener("click", () => cancelTask(task.id));
  const retryButton = els.detail.querySelector("[data-retry-task]");
  if (retryButton) retryButton.addEventListener("click", () => rerunTask(task.id, "retry"));
  const retryFailedPartsButton = els.detail.querySelector("[data-retry-failed-parts]");
  if (retryFailedPartsButton) retryFailedPartsButton.addEventListener("click", () => rerunTask(task.id, "retry-failed-parts"));
  const resumeButton = els.detail.querySelector("[data-resume-task]");
  if (resumeButton) resumeButton.addEventListener("click", () => rerunTask(task.id, "resume"));
  const rollbackButton = els.detail.querySelector("[data-rollback-task]");
  if (rollbackButton) rollbackButton.addEventListener("click", () => rollbackTask(task.id));
  for (const button of els.detail.querySelectorAll("[data-io-tab]")) {
    button.addEventListener("click", () => selectIoTab(button.dataset.ioTab));
  }
  restoreDetailViewState(previousViewState);
  void loadProjectMemory(task.workspace);
}

async function loadProjectMemory(workspace) {
  if (!workspace) return;
  try {
    const response = await fetch("/api/project-memory?workspace=" + encodeURIComponent(workspace));
    const data = await response.json();
    state.projectMemoryByWorkspace[workspace] = data;
  } catch (error) {
    state.projectMemoryByWorkspace[workspace] = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  renderProjectMemoryContent(workspace);
}

function renderProjectMemoryPanel(task) {
  return \`
    <div class="panel section project-memory-panel">
      <h3>Project memory</h3>
      <div data-project-memory-workspace="\${escapeAttr(task.workspace || "")}">
        <span class="meta">Loading remembered project context...</span>
      </div>
    </div>
  \`;
}

function renderProjectMemoryContent(workspace) {
  const target = Array.from(els.detail.querySelectorAll("[data-project-memory-workspace]"))
    .find(item => item.dataset.projectMemoryWorkspace === workspace);
  if (!target) return;
  const memory = state.projectMemoryByWorkspace[workspace];
  if (!memory) {
    target.innerHTML = '<span class="meta">Loading remembered project context...</span>';
    return;
  }
  if (!memory.ok) {
    target.innerHTML = '<span class="meta">Project memory unavailable: ' + escapeHtml(memory.error || "unknown error") + '</span>';
    return;
  }
  const entries = memory.entries || [];
  if (entries.length === 0) {
    target.innerHTML = '<span class="meta">No project memory recorded yet. Completed tasks will populate this automatically.</span>';
    return;
  }
  target.innerHTML = \`
    <span class="meta">Stored at \${escapeHtml(memory.markdownPath || "")}</span>
    <div class="memory-list">\${entries.slice(0, 5).map(entry => \`
      <div class="memory-entry">
        <strong>\${escapeHtml(entry.request || entry.taskId || "Task")}</strong>
        <span class="meta">\${escapeHtml([entry.status, entry.providerAttempts?.join(" -> "), entry.verificationStatus ? "verify " + entry.verificationStatus : ""].filter(Boolean).join(" / "))}</span>
        <span>\${escapeHtml(entry.summary || "-")}</span>
        \${(entry.changedFiles || []).length > 0 ? '<span class="meta">Files: ' + escapeHtml(entry.changedFiles.join(", ")) + '</span>' : ''}
      </div>
    \`).join("")}</div>
  \`;
}

function captureDetailViewState() {
  return {
    scrollTop: els.detail.scrollTop,
    openDetails: Array.from(els.detail.querySelectorAll("details")).map((item, index) => item.open ? String(index) : "").filter(Boolean),
    preScrolls: Array.from(els.detail.querySelectorAll("pre")).map((item, index) => ({ index, scrollTop: item.scrollTop, scrollLeft: item.scrollLeft }))
  };
}

function restoreDetailViewState(viewState) {
  if (!viewState) return;
  const openDetails = new Set(viewState.openDetails || []);
  Array.from(els.detail.querySelectorAll("details")).forEach((item, index) => {
    item.open = openDetails.has(String(index));
  });
  for (const saved of viewState.preScrolls || []) {
    const item = els.detail.querySelectorAll("pre")[saved.index];
    if (!item) continue;
    item.scrollTop = saved.scrollTop || 0;
    item.scrollLeft = saved.scrollLeft || 0;
  }
  els.detail.scrollTop = viewState.scrollTop || 0;
}

function renderDiffPanel(task) {
  const diff = task.gitDiff;
  const checkpoint = task.gitCheckpoint;
  if (!diff && !checkpoint) return "";
  return \`
    <div class="panel section diff-panel">
      <div class="panel-head">
        <h3>Git diff</h3>
        <span class="meta">\${escapeHtml(task.rollback?.status || "not available")}</span>
      </div>
      \${kv("Checkpoint", checkpoint?.supported ? (checkpoint.clean ? "clean" : "dirty") : checkpoint?.error || "not available")}
      \${kv("HEAD", checkpoint?.head || "")}
      \${kv("Files", String((diff?.files || []).length))}
      \${task.rollback?.error ? kv("Rollback", task.rollback.error) : ""}
      <div class="pill-line">\${(diff?.files || []).map(file => '<span class="pill">' + escapeHtml(file.status + ': ' + file.path) + '</span>').join("") || '<span class="meta">No git file changes recorded.</span>'}</div>
      \${diff?.patch ? '<pre>' + escapeHtml(diff.patch) + '</pre>' : '<span class="meta">No tracked-file patch available.</span>'}
    </div>
  \`;
}

function renderWorkflowStatePanel(task) {
  const workflowState = task.workflow?.state;
  if (!workflowState) return "";
  const steps = workflowState.steps || [];
  return \`
    <div class="panel section">
      <h3>Workflow state</h3>
      \${kv("Phase", workflowState.phase || "")}
      \${kv("Next action", workflowState.nextAction?.kind || "")}
      \${kv("Reason", workflowState.nextAction?.reason || "")}
      \${kv("State path", workflowState.statePath || task.workflow?.statePath || "")}
      <ul class="workflow-steps">\${steps.map(step => '<li class="workflow-step"><span class="status workflow-step-status ' + escapeAttr(step.status || '') + '">' + escapeHtml(step.status || 'unknown') + '</span><span class="workflow-step-id">' + escapeHtml((step.kind || 'task') + ' ' + (step.taskId || '')) + '</span><span class="workflow-step-body">' + escapeHtml(step.text || '') + '</span></li>').join("") || '<li class="workflow-step-empty">No workflow steps recorded.</li>'}</ul>
      \${(workflowState.learnings || []).length > 0 ? '<h3>Learnings</h3><ul class="finding-list">' + workflowState.learnings.map(learning => '<li>' + escapeHtml(learning.taskId + ': ' + learning.summary) + '</li>').join("") + '</ul>' : ''}
    </div>
  \`;
}

function renderRequirementProgressPanel(task, output, relatedTasks) {
  const units = buildExecutionUnits(task, output, relatedTasks);
  const total = units.length || 1;
  const completed = units.filter(unit => unit.status === "completed").length;
  const running = units.filter(unit => unit.status === "running").length;
  const failed = units.filter(unit => unit.status === "failed" || unit.status === "interrupted").length;
  const pending = units.filter(unit => unit.status === "pending").length;
  const progressPercent = Math.round((completed / total) * 100);
  const planPath = task.planPath || output.planSummary?.path || "";
  return \`
    <div class="panel section user-progress-panel">
      <div class="panel-head">
        <h3>Requirement progress</h3>
        <span class="status \${escapeAttr(task.status)}">\${escapeHtml(displayTaskStatus(task))}</span>
      </div>
      <div class="progress-overview">
        <div class="progress-card"><span>Plan units</span><strong>\${escapeHtml(total)}</strong></div>
        <div class="progress-card"><span>Completed</span><strong>\${escapeHtml(completed)}</strong></div>
        <div class="progress-card"><span>Running</span><strong>\${escapeHtml(running)}</strong></div>
        <div class="progress-card"><span>Pending</span><strong>\${escapeHtml(pending)}</strong></div>
        <div class="progress-card"><span>Failed</span><strong>\${escapeHtml(failed)}</strong></div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width: \${progressPercent}%"></div></div>
      <div class="result-grid">
        \${kv("Progress", String(completed) + "/" + String(total) + " (" + String(progressPercent) + "%)")}
        \${kv("Workspace", task.workspace || "")}
        \${kv("Plan ID", task.planId || "")}
        \${kv("Plan file", planPath)}
      </div>
      \${renderTaskActionButtons(task, output)}
    </div>
  \`;
}

function renderPlanUnitsPanel(task, output, relatedTasks) {
  const units = buildExecutionUnits(task, output, relatedTasks);
  return \`
    <div class="panel section">
      <div class="panel-head">
        <h3>Plan units</h3>
        <span class="meta">\${escapeHtml(String(units.length || 1))} execution item\${(units.length || 1) === 1 ? "" : "s"}</span>
      </div>
      <div class="plan-unit-list">
        \${units.map(unit => \`
          <div class="plan-unit \${escapeAttr(unit.status)}">
            <span class="plan-unit-label">\${escapeHtml(unit.label)}</span>
            <span class="plan-unit-main">
              <span class="plan-unit-title">\${escapeHtml(unit.title)}</span>
              <span class="plan-unit-meta">\${escapeHtml(unit.meta)}</span>
            </span>
            <span class="status \${escapeAttr(unit.status)}">\${escapeHtml(unit.status)}</span>
          </div>
        \`).join("")}
      </div>
    </div>
  \`;
}

function buildExecutionUnits(task, output, relatedTasks) {
  const workflowSteps = task.workflow?.state?.steps || [];
  const stepByTaskId = new Map(workflowSteps.filter(step => step.taskId).map(step => [step.taskId, step]));
  const orderedIds = [...(task.childTaskIds || [])];
  if (task.reviewTaskId && !orderedIds.includes(task.reviewTaskId)) orderedIds.push(task.reviewTaskId);
  const order = new Map(orderedIds.map((id, index) => [id, index]));
  const related = [...(relatedTasks || [])].sort((a, b) => {
    const left = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
    const right = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
    return left - right;
  });
  if (related.length > 0) {
    return related.map((node, index) => {
      const step = stepByTaskId.get(node.id);
      return {
        id: node.id,
        label: node.id === task.reviewTaskId ? "Review" : unitLabel(node.id, index),
        title: unitTitle(step?.text || node.request || node.id),
        meta: unitMeta(node),
        status: node.status || step?.status || "pending"
      };
    });
  }
  if (orderedIds.length > 0) {
    return orderedIds.map((id, index) => {
      const step = stepByTaskId.get(id);
      return {
        id,
        label: id === task.reviewTaskId ? "Review" : unitLabel(id, index),
        title: unitTitle(step?.text || id),
        meta: "Waiting for task details",
        status: step?.status || "pending"
      };
    });
  }
  const plan = task.workflow?.summary ? workflowPlanSummary(task, output.planSummary) : output.planSummary;
  if (plan?.steps?.length > 0) {
    return plan.steps.map((step, index) => ({
      id: "plan-step-" + String(index + 1),
      label: "Step " + String(index + 1),
      title: unitTitle(step.text || ""),
      meta: step.completed ? "Checklist item completed" : "Checklist item pending",
      status: step.completed ? "completed" : task.status === "running" ? "running" : "pending"
    }));
  }
  return [{
    id: task.id,
    label: "Task",
    title: unitTitle(task.request || task.id),
    meta: unitMeta(task),
    status: task.status || "pending"
  }];
}

function unitMeta(task) {
  const agent = task.preferredAgent || task.profile || "";
  const stage = (task.stages || []).join(" -> ");
  const verification = task.verification?.status ? "verify " + task.verification.status : "";
  const duration = task.runtime?.durationMs ? formatDuration(task.runtime.durationMs) : "";
  return [agent, stage, verification, duration].filter(Boolean).join(" / ");
}

function renderTaskActionButtons(task, output) {
  const summary = output.transcriptSummary;
  const canCancel = state.capabilities.liveTaskManager && (task.status === "running" || task.status === "pending");
  const canRetry = task.kind !== "workflow" && state.capabilities.liveTaskTools && ["failed", "interrupted", "cancelled"].includes(task.status);
  const canRetryFailedParts = task.kind === "workflow" && state.capabilities.liveTaskManager && ["failed", "interrupted", "cancelled"].includes(task.status);
  const canResume = canRetry && Boolean(task.agentSessionId || summary?.sessionId);
  const canRollback = task.kind !== "workflow" && state.capabilities.liveTaskManager && task.rollback?.status === "ready";
  if (!canCancel && !canRetry && !canResume && !canRetryFailedParts && !canRollback) return "";
  return '<div class="actions">' +
    (canCancel ? '<button class="danger-button" type="button" data-cancel-task="' + escapeAttr(task.id) + '">Cancel task</button>' : '') +
    (canRetryFailedParts ? '<button class="secondary-button" type="button" data-retry-failed-parts="' + escapeAttr(task.id) + '">Retry failed parts</button>' : '') +
    (canRetry ? '<button class="secondary-button" type="button" data-retry-task="' + escapeAttr(task.id) + '">Retry</button>' : '') +
    (canResume ? '<button class="secondary-button" type="button" data-resume-task="' + escapeAttr(task.id) + '">Resume</button>' : '') +
    (canRollback ? '<button class="danger-button" type="button" data-rollback-task="' + escapeAttr(task.id) + '">Rollback task</button>' : '') +
    '</div>';
}

function unitLabel(id, index) {
  const match = String(id || "").match(/part-(\\d+)$/);
  return match ? "Plan " + match[1] : "Plan " + String(index + 1);
}

function unitTitle(text) {
  const compact = compactText(text);
  const assigned = compact.match(/Assigned subtask\\s+\\d+\\/\\d+\\s*:\\s*(.+?)(?:\\s+Plan file:|$)/i);
  if (assigned) return cleanUnitTitle(truncateText(assigned[1], 180));
  if (/^Review the completed/i.test(compact)) return "Review implementation results";
  if (/^Execute only the assigned subtask/i.test(compact)) return cleanUnitTitle(truncateText(compact.replace(/^Execute only the assigned subtask from the implementation plan below\\.\\s*/i, ""), 180));
  return cleanUnitTitle(truncateText(compact, 180));
}

function compactText(text) {
  return String(text || "").replace(/\\s+/g, " ").trim();
}

function cleanUnitTitle(text) {
  const tick = String.fromCharCode(96);
  return String(text || "").replace(/\\*\\*/g, "").split(tick).join("").trim();
}

function truncateText(text, maxLength) {
  const compact = compactText(text);
  return compact.length > maxLength ? compact.slice(0, maxLength - 1) + "..." : compact;
}

function renderResultSummaryPanel(task) {
  const result = task.resultSummary;
  if (!result) return "";
  const sessions = result.agentSessions || [];
  return \`
    <div class="panel section result-summary-panel">
      <div class="panel-head">
        <h3>Result summary</h3>
        <span class="status \${escapeAttr(result.status || task.status)}">\${escapeHtml(displayTaskStatus({ ...task, status: result.status || task.status }))}</span>
      </div>
      <p class="result-lede">\${escapeHtml(result.summary || "No result summary is available yet.")}</p>
      <div class="result-grid">
        \${kv("Provider", result.provider || task.preferredAgent || "")}
        \${kv("Provider attempts", (result.providerAttempts || []).join(" -> "))}
        \${kv("Quality", result.quality ? result.quality.status + " (" + result.quality.score + ")" : "")}
        \${kv("Failure category", result.failure?.category || "")}
        \${kv("Duration", result.durationMs !== undefined ? formatDuration(result.durationMs) : "")}
        \${kv("Verification", result.verification ? result.verification.status + (result.verification.exitCode !== undefined ? " (" + result.verification.exitCode + ")" : "") : "")}
        \${kv("Repaired by", result.verification?.repairedBy || task.verification?.repairTaskId || "")}
        \${kv("Sessions", sessions.map(session => session.agent + ": " + session.sessionId).join(", "))}
      </div>
      \${renderQualityPanel(result)}
      <div class="result-block">
        <h3>Changed files</h3>
        <div class="pill-line">\${(result.changedFiles || []).map(file => '<span class="pill">' + escapeHtml(file) + '</span>').join("") || '<span class="meta">No changed files recorded.</span>'}</div>
      </div>
      <div class="result-block">
        <h3>Next steps</h3>
        \${(result.nextSteps || []).length > 0 ? '<ul class="finding-list">' + result.nextSteps.map(step => '<li>' + escapeHtml(step) + '</li>').join("") + '</ul>' : '<span class="meta">No next steps recorded.</span>'}
      </div>
      \${renderGuardrailsPanel(result.guardrails || task.guardrails || [])}
    </div>
  \`;
}

function renderQualityPanel(result) {
  if (!result.quality && !result.failure) return "";
  return \`
    <div class="result-block">
      <h3>Quality assessment</h3>
      \${result.quality ? '<ul class="finding-list">' + (result.quality.reasons || []).map(reason => '<li>' + escapeHtml(reason) + '</li>').join("") + '</ul>' : ''}
      \${result.failure ? \`
        <div class="guardrail-item error">
          <strong>\${escapeHtml(result.failure.category || "failure")}</strong>
          <span>\${escapeHtml(result.failure.message || "")}</span>
          <span class="meta">Suggested action: \${escapeHtml(result.failure.nextAction || "")}</span>
        </div>
      \` : ''}
    </div>
  \`;
}

function renderGuardrailsPanel(guardrails) {
  if (!guardrails || guardrails.length === 0) return "";
  return \`
    <div class="result-block">
      <h3>Guardrails</h3>
      <div class="guardrail-list">\${guardrails.map(issue => \`
        <div class="guardrail-item \${escapeAttr(issue.severity || "warning")}">
          <strong>\${escapeHtml(issue.kind || "guardrail")} / \${escapeHtml(issue.severity || "warning")}</strong>
          <span>\${escapeHtml(issue.message || "")}</span>
          \${issue.file ? '<span class="meta">File: ' + escapeHtml(issue.file) + '</span>' : ''}
          \${issue.evidence ? '<span class="meta">Evidence: ' + escapeHtml(issue.evidence) + '</span>' : ''}
        </div>
      \`).join("")}</div>
    </div>
  \`;
}

function renderRuntimePanel(task) {
  const runtime = task.runtime;
  if (!runtime) return "";
  const outputFiles = runtime.outputFiles || [];
  const liveChangedFiles = runtime.liveChangedFiles || [];
  return \`
    <div class="panel section runtime-panel">
      <div class="panel-head">
        <h3>Runtime</h3>
        \${task.status === "running" || task.status === "pending" ? '<span class="status running">live</span>' : '<span class="meta">snapshot</span>'}
      </div>
      <div class="result-grid">
        \${kv("Duration", formatDuration(runtime.durationMs))}
        \${kv("Output bytes", formatBytes(runtime.outputBytes || 0))}
        \${kv("Last output", runtime.lastOutputAt ? formatTime(runtime.lastOutputAt) : "")}
        \${kv("Output files", String(outputFiles.length))}
      </div>
      <div class="result-block">
        <h3>Live changed files</h3>
        <div class="pill-line">\${liveChangedFiles.map(file => '<span class="pill">' + escapeHtml(file) + '</span>').join("") || '<span class="meta">No live git changes detected.</span>'}</div>
      </div>
      <div class="result-block">
        <h3>Output files</h3>
        <div class="runtime-file-list">\${outputFiles.map(file => '<div class="runtime-file"><span>' + escapeHtml(shortPath(file.path)) + '</span><span class="meta">' + escapeHtml(formatBytes(file.bytes)) + (file.modifiedAt ? ' / ' + escapeHtml(formatTime(file.modifiedAt)) : '') + '</span></div>').join("") || '<span class="meta">No output files have been written yet.</span>'}</div>
      </div>
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
      \${kv("Sandbox", verification.tmpDir || "")}
      \${kv("Repair task", verification.repairTaskId || "")}
      \${output ? '<pre>' + escapeHtml(output) + '</pre>' : '<span class="meta">No verification output available.</span>'}
    </div>
  \`;
}

function renderOutcomePanel(task, output) {
  const deliveryReport = output.deliveryReport;
  const report = finalReportArtifact(output);
  const stageSummary = stageResults(task).map(result => result.summary).filter(Boolean).join("\\n\\n");
  const content = deliveryReport?.markdown || report?.content || stageSummary || task.error || "";
  return \`
    <div class="panel section outcome-panel">
      <div class="panel-head"><h3>Final report</h3>\${deliveryReport ? '<span class="meta">' + escapeHtml(deliveryReport.statusLabel || "delivery") + '</span>' : report ? '<span class="meta">' + escapeHtml(report.path) + '</span>' : ''}</div>
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

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return "0s";
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return String(seconds) + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return String(minutes) + "m " + String(seconds % 60) + "s";
  const hours = Math.floor(minutes / 60);
  return String(hours) + "h " + String(minutes % 60) + "m";
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return String(value) + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / 1024 / 1024).toFixed(1) + " MB";
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function shortPath(path) {
  const text = String(path || "");
  const marker = "/.agent-runs/";
  const index = text.indexOf(marker);
  if (index >= 0) return text.slice(index + 1);
  const parts = text.split("/");
  return parts.length > 4 ? parts.slice(-4).join("/") : text;
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
