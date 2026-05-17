import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DelegatedTask, StageResult } from "../types.js";

export interface BackgroundOutput {
  task: DelegatedTask;
  artifacts: Array<{ path: string; content: string }>;
  transcript?: { path: string; tail: string };
}

export async function readBackgroundOutput(task: DelegatedTask, maxBytes = 12_000): Promise<BackgroundOutput> {
  const artifacts = await readArtifacts(task, maxBytes);
  const transcriptPath = latestClaudeResult(task)?.agentTranscriptPath;
  const transcript = transcriptPath
    ? { path: transcriptPath, tail: await readTail(transcriptPath, maxBytes) }
    : undefined;
  return { task, artifacts, transcript };
}

async function readArtifacts(task: DelegatedTask, maxBytes: number): Promise<Array<{ path: string; content: string }>> {
  const files = task.stages.flatMap(stage => [
    join(task.workspace, ".agent-runs", task.runId, `${stage}.output.md`),
    join(task.workspace, ".agent-runs", task.runId, `claude-${stage}.log`)
  ]);
  const result: Array<{ path: string; content: string }> = [];
  for (const path of files) {
    const content = await readTail(path, maxBytes);
    if (content.length > 0) result.push({ path, content });
  }
  return result;
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > maxBytes ? content.slice(-maxBytes) : content;
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
