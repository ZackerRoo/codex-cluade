import type { DelegatedTask, DeliveryReport, TaskStatus } from "../types.js";

export function buildDeliveryReport(task: DelegatedTask, relatedTasks: DelegatedTask[] = []): DeliveryReport {
  const statusLabel = deliveryStatusLabel(task);
  const summary = task.resultSummary?.summary || task.error || fallbackSummary(task.status);
  const sections = [
    section("Outcome", outcomeItems(task, statusLabel, summary)),
    section("Execution", executionItems(task)),
    section("Plan units", planUnitItems(task, relatedTasks)),
    section("Changed files", changedFileItems(task, relatedTasks)),
    section("Verification", verificationItems(task)),
    section("Review findings", reviewFindingItems(task, relatedTasks)),
    section("How to use", usageItems(task)),
    section("Next steps", nextStepItems(task))
  ].filter(item => item.items.length > 0);
  const markdown = [
    "# Delivery report",
    "",
    `Task: ${task.id}`,
    `Status: ${statusLabel}`,
    `Workspace: ${task.workspace}`,
    "",
    ...sections.flatMap(item => [
      `## ${item.title}`,
      "",
      ...item.items.map(value => `- ${value}`),
      ""
    ])
  ].join("\n").trimEnd();
  return {
    title: "Delivery report",
    statusLabel,
    summary,
    sections,
    markdown
  };
}

function section(title: string, items: string[]): DeliveryReport["sections"][number] {
  return { title, items: items.filter(Boolean) };
}

function deliveryStatusLabel(task: DelegatedTask): string {
  if (task.status === "completed" && task.verification?.status === "passed" && task.verification.repairTaskId) return "completed after repair";
  return task.status;
}

function outcomeItems(task: DelegatedTask, statusLabel: string, summary: string): string[] {
  return [
    `Requirement: ${compact(task.request) || task.id}`,
    `Result: ${statusLabel}`,
    task.resultSummary?.quality ? `Quality: ${task.resultSummary.quality.status} (${task.resultSummary.quality.score})` : "",
    ...(task.resultSummary?.quality?.reasons ?? []).map(reason => `Quality reason: ${compact(reason)}`),
    task.resultSummary?.failure ? `Failure category: ${task.resultSummary.failure.category}` : "",
    task.resultSummary?.failure?.nextAction ? `Suggested action: ${compact(task.resultSummary.failure.nextAction)}` : "",
    summary ? `Summary: ${compact(summary)}` : "",
    task.verification?.repairTaskId ? `Repair task: ${task.verification.repairTaskId}` : "",
    task.error ? `Error: ${compact(task.error)}` : ""
  ];
}

function executionItems(task: DelegatedTask): string[] {
  const result = task.resultSummary;
  const attempts = result?.providerAttempts ?? (task.preferredAgent ? [task.preferredAgent] : []);
  return [
    task.profile ? `Profile: ${task.profile}` : "",
    task.category ? `Category: ${task.category}` : "",
    result?.provider || task.preferredAgent ? `Final provider: ${result?.provider ?? task.preferredAgent}` : "",
    attempts.length > 0 ? `Provider attempts: ${attempts.join(" -> ")}` : "",
    task.stages.length > 0 ? `Stages: ${task.stages.join(" -> ")}` : "",
    result?.durationMs !== undefined ? `Duration: ${formatDuration(result.durationMs)}` : ""
  ];
}

function planUnitItems(task: DelegatedTask, relatedTasks: DelegatedTask[]): string[] {
  const summary = task.workflow?.summary ?? task.resultSummary?.childSummary;
  const totals = summary
    ? [`${summary.completed}/${summary.total} completed, ${summary.failed} failed, ${summary.running} running, ${summary.pending} pending`]
    : [];
  const units = relatedTasks.map(child => `${child.id}: ${child.status}${child.profile ? ` (${child.profile})` : ""}`);
  return [...totals, ...units];
}

function changedFileItems(task: DelegatedTask, relatedTasks: DelegatedTask[]): string[] {
  const files = unique([
    ...(task.resultSummary?.changedFiles ?? []),
    ...(task.gitDiff?.files ?? []).map(file => file.path),
    ...relatedTasks.flatMap(child => child.resultSummary?.changedFiles ?? []),
    ...relatedTasks.flatMap(child => (child.gitDiff?.files ?? []).map(file => file.path))
  ]);
  return files.length > 0 ? files : ["No changed files recorded."];
}

function verificationItems(task: DelegatedTask): string[] {
  const verification = task.verification;
  if (!task.verifyCommand && !verification) return ["No verification command was recorded."];
  return [
    `Command: ${verification?.command ?? task.verifyCommand}`,
    verification?.status ? `Status: ${verification.status}` : "Status: not started",
    verification?.exitCode !== undefined ? `Exit code: ${verification.exitCode}` : "",
    verification?.timedOut ? "Timed out: true" : "",
    verification?.tmpDir ? `Sandbox: ${verification.tmpDir}` : "",
    verification?.tmpDir ? "Sandbox env: CODEX_CLAUDE_VERIFY_TMP" : "",
    verification?.repairTaskId ? `Repair task: ${verification.repairTaskId}` : "",
    verification?.error ? `Error: ${compact(verification.error)}` : ""
  ];
}

function reviewFindingItems(task: DelegatedTask, relatedTasks: DelegatedTask[]): string[] {
  const nextSteps = task.resultSummary?.nextSteps ?? [];
  const reviewSummaries = relatedTasks
    .filter(child => child.stages.includes("review") || child.id === task.reviewTaskId)
    .map(child => child.resultSummary?.summary || child.error || "")
    .filter(Boolean)
    .map(compact);
  return [...reviewSummaries, ...nextSteps].length > 0
    ? [...reviewSummaries, ...nextSteps]
    : ["No review findings recorded."];
}

function usageItems(task: DelegatedTask): string[] {
  const files = task.resultSummary?.changedFiles ?? [];
  if (files.some(file => /(^|\/)index\.html$/i.test(file))) return ["Open index.html from the workspace in a browser."];
  if (files.some(file => /(^|\/)package\.json$/i.test(file))) return ["Use the project package scripts from package.json, then run the recorded verification command if available."];
  if (files.some(file => /(^|\/)CMakeLists\.txt$/i.test(file))) return ["Configure and build with CMake from the workspace, then run the recorded verification command if available."];
  if (task.verifyCommand) return ["Run the recorded verification command before shipping changes."];
  return ["Inspect the changed files in the workspace and use the project’s normal run command."];
}

function nextStepItems(task: DelegatedTask): string[] {
  const steps = task.resultSummary?.nextSteps ?? [];
  if (steps.length > 0) return steps;
  if (isTerminalFailure(task.status)) return ["Inspect the error output, then retry, resume, or repair the task."];
  if (task.status === "completed") return ["Review the changed files before committing or shipping."];
  return ["Wait for the task to finish, then review the final report again."];
}

function fallbackSummary(status: TaskStatus): string {
  if (status === "completed") return "Task completed.";
  if (status === "running") return "Task is running.";
  if (status === "pending") return "Task is pending.";
  return "Task did not complete successfully.";
}

function isTerminalFailure(status: TaskStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "interrupted";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compact(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
