import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readdir, stat } from "node:fs/promises";

export interface ClaudeSessionInfo {
  sessionId: string;
  transcriptPath: string;
  resumeCommand: string;
}

export async function resolveClaudeSessionInfo(input: {
  workspace: string;
  stdout: string;
  startedAt: Date;
  claudePath: string;
}): Promise<ClaudeSessionInfo | undefined> {
  const sessionId = extractSessionIdFromStdout(input.stdout);
  if (sessionId) {
    const transcriptPath = await findTranscriptBySessionId(input.workspace, sessionId);
    return {
      sessionId,
      transcriptPath: transcriptPath ?? defaultTranscriptPath(input.workspace, sessionId),
      resumeCommand: buildResumeCommand(input.workspace, input.claudePath, sessionId)
    };
  }

  const transcript = await findRecentTranscript(input.workspace, input.startedAt);
  if (!transcript) return undefined;
  return {
    sessionId: transcript.sessionId,
    transcriptPath: transcript.path,
    resumeCommand: buildResumeCommand(input.workspace, input.claudePath, transcript.sessionId)
  };
}

function extractSessionIdFromStdout(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const value = parsed.session_id ?? parsed.sessionId;
    return typeof value === "string" && isUuid(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function findTranscriptBySessionId(workspace: string, sessionId: string): Promise<string | undefined> {
  const path = defaultTranscriptPath(workspace, sessionId);
  try {
    await stat(path);
    return path;
  } catch {
    return undefined;
  }
}

async function findRecentTranscript(
  workspace: string,
  startedAt: Date
): Promise<{ sessionId: string; path: string } | undefined> {
  const dir = projectTranscriptDir(workspace);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }

  const candidates: Array<{ sessionId: string; path: string; mtimeMs: number }> = [];
  const startedAtMs = startedAt.getTime();
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const sessionId = basename(entry, ".jsonl");
    if (!isUuid(sessionId)) continue;
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (info.mtimeMs >= startedAtMs - 5_000) {
        candidates.push({ sessionId, path, mtimeMs: info.mtimeMs });
      }
    } catch {
      // Ignore files that disappeared while scanning.
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0];
}

function defaultTranscriptPath(workspace: string, sessionId: string): string {
  return join(projectTranscriptDir(workspace), `${sessionId}.jsonl`);
}

function projectTranscriptDir(workspace: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectPath(workspace));
}

function encodeProjectPath(workspace: string): string {
  return workspace.replaceAll("/", "-");
}

function buildResumeCommand(workspace: string, claudePath: string, sessionId: string): string {
  return `cd ${shellQuote(workspace)} && ${shellQuote(claudePath)} --resume ${sessionId}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
