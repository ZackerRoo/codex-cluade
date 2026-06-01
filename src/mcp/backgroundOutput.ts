import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseClaudeTranscript, type ClaudeTranscriptSummary } from "../agents/ClaudeTranscript.js";
import type { DelegatedTask, StageResult } from "../types.js";
import { parsePlanChecklist, type PlanSummary } from "../workflow/PlanParser.js";
import { TaskStore } from "../workflow/TaskStore.js";

export interface BackgroundOutputEvent {
  source: "artifact" | "transcript";
  path: string;
  offset: number;
  content: string;
}

export interface BackgroundOutput {
  task: DelegatedTask;
  artifacts: Array<{ path: string; content: string }>;
  transcript?: { path: string; tail: string };
  transcriptSummary?: ClaudeTranscriptSummary;
  planSummary?: PlanSummary & { path: string };
  events: BackgroundOutputEvent[];
  cursor: number;
  nextCursor: number;
  hasMore: boolean;
}

export type TaskLookup = (taskId: string) => DelegatedTask | undefined;

export async function readBackgroundOutput(
  task: DelegatedTask,
  maxBytes = 12_000,
  cursor = 0,
  taskLookup?: TaskLookup
): Promise<BackgroundOutput> {
  const transcriptPath = latestClaudeResult(task)?.agentTranscriptPath;
  const artifacts = cursor > 0 ? [] : await readArtifacts(task, maxBytes, taskLookup);
  const transcriptContent = transcriptPath ? await readFileOrEmpty(transcriptPath) : "";
  const transcript = transcriptPath && cursor === 0
    ? { path: transcriptPath, tail: tailText(transcriptContent, maxBytes) }
    : undefined;
  const transcriptSummary = transcriptContent ? parseClaudeTranscript(transcriptContent) : undefined;
  const planContent = task.planPath ? await readFileOrEmpty(task.planPath) : "";
  const planSummary = task.planPath && planContent
    ? { path: task.planPath, ...parsePlanChecklist(planContent) }
    : undefined;
  const eventSources = [
    ...(await eventArtifactPaths(task, taskLookup)).map(path => ({ source: "artifact" as const, path })),
    ...(transcriptPath ? [{ source: "transcript" as const, path: transcriptPath }] : [])
  ];
  const { events, nextCursor } = await readIncrementalEvents(eventSources, cursor, maxBytes);
  return { task, artifacts, transcript, transcriptSummary, planSummary, events, cursor, nextCursor, hasMore: false };
}

async function readArtifacts(
  task: DelegatedTask,
  maxBytes: number,
  taskLookup?: TaskLookup
): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  for (const path of artifactPaths(task)) {
    const content = await readTail(path, maxBytes);
    if (content.length > 0) result.push({ path, content });
  }
  const workflowOutput = await buildWorkflowOutputArtifact(task, maxBytes, taskLookup);
  if (workflowOutput) result.push(workflowOutput);
  const workflowState = buildWorkflowStateArtifact(task, maxBytes);
  if (workflowState) result.push(workflowState);
  return result;
}

async function eventArtifactPaths(task: DelegatedTask, taskLookup?: TaskLookup): Promise<string[]> {
  const paths = [...artifactPaths(task)];
  if (task.kind !== "workflow") return paths;
  for (const child of lookupWorkflowTasks(task, taskLookup)) {
    paths.push(...artifactPaths(child));
  }
  return [...new Set(paths)];
}

function artifactPaths(task: DelegatedTask): string[] {
  return [
    ...(task.planPath ? [task.planPath] : []),
    ...task.stages.flatMap(stage => [
      join(task.workspace, ".agent-runs", task.runId, `${stage}.input.md`),
      join(task.workspace, ".agent-runs", task.runId, `claude-${stage}.stderr.log`),
      join(task.workspace, ".agent-runs", task.runId, `claude-${stage}.log`),
      join(task.workspace, ".agent-runs", task.runId, `claude-${stage}.stdout.jsonl`),
      join(task.workspace, ".agent-runs", task.runId, `codex-cli-${stage}.stdout.log`),
      join(task.workspace, ".agent-runs", task.runId, `codex-cli-${stage}.stderr.log`),
      join(task.workspace, ".agent-runs", task.runId, `gemini-${stage}.stdout.log`),
      join(task.workspace, ".agent-runs", task.runId, `gemini-${stage}.stderr.log`),
      join(task.workspace, ".agent-runs", task.runId, `opencode-${stage}.stdout.log`),
      join(task.workspace, ".agent-runs", task.runId, `opencode-${stage}.stderr.log`),
      join(task.workspace, ".agent-runs", task.runId, `${stage}.output.md`)
    ])
  ];
}

async function buildWorkflowOutputArtifact(
  task: DelegatedTask,
  maxBytes: number,
  taskLookup?: TaskLookup
): Promise<{ path: string; content: string } | undefined> {
  if (task.kind !== "workflow") return undefined;
  const children = lookupWorkflowTasks(task, taskLookup);
  if (children.length === 0) return undefined;

  const lines = [
    `# Workflow output`,
    "",
    `Task: ${task.id}`,
    `Status: ${task.status}`,
    task.workflow?.summary
      ? `Summary: ${task.workflow.summary.completed}/${task.workflow.summary.total} completed, ${task.workflow.summary.failed} failed, ${task.workflow.summary.running} running, ${task.workflow.summary.pending} pending`
      : undefined,
    ""
  ].filter((line): line is string => line !== undefined);

  for (const child of children) {
    lines.push(`## ${child.id}`, "", `Status: ${child.status}`, `Profile: ${child.profile ?? child.preferredAgent ?? "-"}`);
    if (child.error) lines.push(`Error: ${child.error}`);
    const summaries = stageResultSummaries(child);
    if (summaries.length > 0) lines.push("", ...summaries);
    const outputs = await stageOutputArtifacts(child, maxBytes);
    for (const output of outputs) {
      lines.push("", `Artifact: ${output.path}`, output.content || "(empty)");
    }
    lines.push("");
  }

  return { path: "workflow-output.md", content: tailText(lines.join("\n"), maxBytes) };
}

function buildWorkflowStateArtifact(task: DelegatedTask, maxBytes: number): { path: string; content: string } | undefined {
  const state = task.workflow?.state;
  if (!state) return undefined;
  const lines = [
    "# Workflow state",
    "",
    `Workflow: ${state.workflowId}`,
    `Phase: ${state.phase}`,
    `Next action: ${state.nextAction.kind}`,
    `Reason: ${state.nextAction.reason}`,
    state.nextAction.taskIds?.length ? `Action task IDs: ${state.nextAction.taskIds.join(", ")}` : undefined,
    state.statePath ? `State path: ${state.statePath}` : undefined,
    "",
    "## Steps",
    ...state.steps.map(step => `- [${step.status === "completed" ? "x" : " "}] ${step.kind} ${step.taskId}: ${step.text} (${step.status})`),
    "",
    "## Learnings",
    ...(
      state.learnings.length > 0
        ? state.learnings.flatMap(learning => [
          `- ${learning.taskId}: ${learning.summary}`,
          learning.changedFiles.length > 0 ? `  Changed files: ${learning.changedFiles.join(", ")}` : undefined
        ]).filter((line): line is string => line !== undefined)
        : ["- none yet"]
    )
  ].filter((line): line is string => line !== undefined);
  return { path: "workflow-state.md", content: tailText(lines.join("\n"), maxBytes) };
}

function lookupWorkflowTasks(task: DelegatedTask, taskLookup?: TaskLookup): DelegatedTask[] {
  const fallbackStore = taskLookup ? undefined : new TaskStore();
  const lookup = (taskId: string) => taskLookup?.(taskId) ?? fallbackStore?.get(taskId);
  const ids = [...(task.childTaskIds ?? [])];
  if (task.reviewTaskId && !ids.includes(task.reviewTaskId)) ids.push(task.reviewTaskId);
  return ids.map(lookup).filter((child): child is DelegatedTask => child !== undefined);
}

async function stageOutputArtifacts(task: DelegatedTask, maxBytes: number): Promise<Array<{ path: string; content: string }>> {
  const paths = [
    ...stageResultOutputPaths(task),
    ...task.stages.map(stage => join(task.workspace, ".agent-runs", task.runId, `${stage}.output.md`))
  ];
  const uniquePaths = [...new Set(paths)];
  const outputs: Array<{ path: string; content: string }> = [];
  for (const path of uniquePaths) {
    const content = await readTail(path, Math.max(2_000, Math.floor(maxBytes / Math.max(1, uniquePaths.length))));
    if (content.length > 0) outputs.push({ path, content });
  }
  return outputs;
}

function stageResultOutputPaths(task: DelegatedTask): string[] {
  return stageResults(task)
    .map(result => result.outputPath)
    .filter((path): path is string => typeof path === "string" && path.length > 0);
}

function stageResultSummaries(task: DelegatedTask): string[] {
  return stageResults(task)
    .filter(result => result.summary || result.error)
    .map(result => [
      `- ${result.stage} / ${result.agent}: ${result.status}`,
      result.summary ? `  ${result.summary}` : undefined,
      result.error ? `  Error: ${result.error}` : undefined
    ].filter((line): line is string => line !== undefined).join("\n"));
}

function stageResults(task: DelegatedTask): StageResult[] {
  const maybeResults = (task.result as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(maybeResults)) return [];
  return maybeResults.filter((result): result is StageResult => {
    return typeof result === "object" && result !== null && typeof (result as StageResult).stage === "string";
  });
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return tailText(content, maxBytes);
  } catch {
    return "";
  }
}

function tailText(content: string, maxBytes: number): string {
  return content.length > maxBytes ? content.slice(-maxBytes) : content;
}

async function readIncrementalEvents(
  sources: Array<{ source: BackgroundOutputEvent["source"]; path: string }>,
  cursor: number,
  maxBytes: number
): Promise<{ events: BackgroundOutputEvent[]; nextCursor: number }> {
  let streamOffset = 0;
  const events: BackgroundOutputEvent[] = [];
  for (const source of sources) {
    const content = await readFileOrEmpty(source.path);
    const start = streamOffset;
    const end = streamOffset + content.length;
    if (end > cursor) {
      const localOffset = Math.max(0, cursor - start);
      const incremental = content.slice(localOffset);
      if (incremental.length > 0) {
        events.push({
          source: source.source,
          path: source.path,
          offset: localOffset,
          content: incremental.length > maxBytes ? incremental.slice(-maxBytes) : incremental
        });
      }
    }
    streamOffset = end;
  }
  return { events, nextCursor: streamOffset };
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function latestClaudeResult(task: DelegatedTask): StageResult | undefined {
  const maybeResults = (task.result as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(maybeResults)) return undefined;
  return [...maybeResults].reverse().find((result): result is StageResult => {
    return typeof result === "object" && result !== null && (result as StageResult).agent === "claude";
  });
}
