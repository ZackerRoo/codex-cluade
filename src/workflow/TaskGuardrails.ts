import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DelegatedTask, GuardrailIssue, StageResult } from "../types.js";

const COMMENT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".java", ".go", ".rs", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".cs", ".kt", ".swift", ".php", ".rb", ".css", ".scss", ".html", ".vue", ".svelte"
]);

export async function evaluateTaskGuardrails(task: DelegatedTask): Promise<GuardrailIssue[]> {
  if (task.kind === "workflow") return [];
  if (task.status !== "completed") return [];

  const results = stageResults(task);
  const issues = [
    ...(await emptyOutputIssues(task, results)),
    ...unfinishedTodoIssues(results),
    ...(await commentDensityIssues(task, results))
  ];
  return issues;
}

async function emptyOutputIssues(task: DelegatedTask, results: StageResult[]): Promise<GuardrailIssue[]> {
  if (results.length === 0) return [];
  if (results.some(result => !result.ok)) return [];
  const hasSummary = results.some(result => result.summary.trim().length > 0);
  const hasChangedFiles = results.some(result => result.changedFiles.length > 0);
  const outputPaths = results.flatMap(result => [result.outputPath, result.logPath]).filter((path): path is string => Boolean(path));
  const hasArtifactOutput = (await Promise.all(outputPaths.map(hasNonEmptyFile))).some(Boolean);
  if (hasSummary || hasChangedFiles || hasArtifactOutput) return [];
  return [{
    kind: "empty_output",
    severity: "error",
    message: "Agent reported success but produced no summary, changed files, or output artifact.",
    evidence: `task=${task.id}`
  }];
}

function unfinishedTodoIssues(results: StageResult[]): GuardrailIssue[] {
  const text = results.map(result => result.summary).join("\n");
  const match = text.match(/(?:^|\n)\s*(?:[-*]\s*)?\[\s\]\s+(.{1,160})/);
  if (!match) return [];
  return [{
    kind: "unfinished_todo",
    severity: "warning",
    message: "Agent output still contains unchecked todo items; inspect whether the task stopped early.",
    evidence: match[1]?.trim()
  }];
}

async function commentDensityIssues(task: DelegatedTask, results: StageResult[]): Promise<GuardrailIssue[]> {
  const files = unique([
    ...results.flatMap(result => result.changedFiles),
    ...(task.gitDiff?.files ?? []).map(file => file.path)
  ]).filter(isLikelySourceFile);
  const issues: GuardrailIssue[] = [];
  for (const file of files) {
    const content = await readWorkspaceFile(task.workspace, file);
    if (!content) continue;
    const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length < 25) continue;
    const commentLines = lines.filter(isCommentLine).length;
    const ratio = commentLines / lines.length;
    if (commentLines >= 20 && ratio >= 0.45) {
      issues.push({
        kind: "comment_density",
        severity: "warning",
        message: `Changed file has high comment density (${commentLines}/${lines.length} non-empty lines).`,
        file,
        evidence: `${Math.round(ratio * 100)}% comments`
      });
    }
  }
  return issues;
}

function stageResults(task: DelegatedTask): StageResult[] {
  const maybeResults = (task.result as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(maybeResults)) return [];
  return maybeResults.filter(isStageResult);
}

function isStageResult(value: unknown): value is StageResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StageResult>;
  return typeof candidate.stage === "string"
    && typeof candidate.agent === "string"
    && typeof candidate.summary === "string"
    && Array.isArray(candidate.changedFiles);
}

async function hasNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function readWorkspaceFile(workspace: string, file: string): Promise<string | undefined> {
  const workspaceRoot = resolve(workspace);
  const target = resolve(workspaceRoot, file);
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${sep}`)) return undefined;
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size > 200_000) return undefined;
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

function isLikelySourceFile(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot >= 0 && COMMENT_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

function isCommentLine(line: string): boolean {
  return line.startsWith("//")
    || line.startsWith("#")
    || line.startsWith("/*")
    || line.startsWith("*")
    || line.startsWith("*/")
    || line.startsWith("<!--")
    || line.startsWith("--");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
