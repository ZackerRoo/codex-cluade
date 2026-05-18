import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DelegatedTask, StageResult } from "../types.js";

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
  events: BackgroundOutputEvent[];
  cursor: number;
  nextCursor: number;
  hasMore: boolean;
}

export async function readBackgroundOutput(task: DelegatedTask, maxBytes = 12_000, cursor = 0): Promise<BackgroundOutput> {
  const transcriptPath = latestClaudeResult(task)?.agentTranscriptPath;
  const artifacts = cursor > 0 ? [] : await readArtifacts(task, maxBytes);
  const transcript = transcriptPath && cursor === 0
    ? { path: transcriptPath, tail: await readTail(transcriptPath, maxBytes) }
    : undefined;
  const eventSources = [
    ...artifactPaths(task).map(path => ({ source: "artifact" as const, path })),
    ...(transcriptPath ? [{ source: "transcript" as const, path: transcriptPath }] : [])
  ];
  const { events, nextCursor } = await readIncrementalEvents(eventSources, cursor, maxBytes);
  return { task, artifacts, transcript, events, cursor, nextCursor, hasMore: false };
}

async function readArtifacts(task: DelegatedTask, maxBytes: number): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  for (const path of artifactPaths(task)) {
    const content = await readTail(path, maxBytes);
    if (content.length > 0) result.push({ path, content });
  }
  return result;
}

function artifactPaths(task: DelegatedTask): string[] {
  return task.stages.flatMap(stage => [
    join(task.workspace, ".agent-runs", task.runId, `${stage}.output.md`),
    join(task.workspace, ".agent-runs", task.runId, `claude-${stage}.log`)
  ]);
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > maxBytes ? content.slice(-maxBytes) : content;
  } catch {
    return "";
  }
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
