import type { AgentName, DelegatedTask, StageResult, TaskResultSummary } from "../types.js";

export function buildTaskResultSummary(task: DelegatedTask, relatedTasks: DelegatedTask[] = []): TaskResultSummary {
  if (task.kind === "workflow") return buildWorkflowSummary(task, relatedTasks);
  const results = stageResults(task);
  const changedFiles = unique(results.flatMap(result => result.changedFiles ?? []));
  const lastResult = [...results].reverse().find(result => result.agent);
  const summary = summarizeTask(task, results);
  return {
    kind: "task",
    status: task.status,
    summary,
    quality: assessQuality(task, changedFiles),
    failure: classifyFailure(task),
    provider: lastResult?.agent ?? task.preferredAgent,
    providerAttempts: providerAttempts(results, task.preferredAgent),
    stages: task.stages ?? [],
    changedFiles,
    agentSessions: agentSessions(results, task.agentSessionId),
    verification: verificationSummary(task),
    durationMs: durationMs(task),
    guardrails: task.guardrails,
    nextSteps: nextSteps(task, changedFiles),
    error: task.error
  };
}

function buildWorkflowSummary(task: DelegatedTask, children: DelegatedTask[]): TaskResultSummary {
  const childSummary = task.workflow?.summary ?? summarizeChildren(children);
  const childChangedFiles = children.map(child => ({
    id: child.id,
    files: child.resultSummary?.changedFiles ?? stageResults(child).flatMap(result => result.changedFiles ?? [])
  }));
  const changedFiles = unique(childChangedFiles.flatMap(child => child.files));
  const sharedFiles = sharedChangedFiles(childChangedFiles);
  const agentSessionItems = uniqueSessions(children.flatMap(child => child.resultSummary?.agentSessions ?? agentSessions(stageResults(child), child.agentSessionId)));
  const summary = [
    `${childSummary.completed}/${childSummary.total} child tasks completed`,
    childSummary.failed > 0 ? `${childSummary.failed} failed` : "",
    task.verification ? `verification ${task.verification.status}` : "",
    sharedFiles.length > 0 ? `${sharedFiles.length} shared files touched by multiple children` : "",
    task.error ? `error: ${task.error}` : ""
  ].filter(Boolean).join("; ");
  return {
    kind: "workflow",
    status: task.status,
    summary,
    quality: assessQuality(task, changedFiles, childSummary),
    failure: classifyFailure(task, childSummary),
    provider: task.preferredAgent,
    providerAttempts: providerAttempts(children.flatMap(child => stageResults(child)), task.preferredAgent),
    stages: task.stages ?? [],
    changedFiles,
    agentSessions: agentSessionItems,
    verification: verificationSummary(task),
    durationMs: durationMs(task),
    guardrails: task.guardrails,
    nextSteps: nextSteps(task, changedFiles, childSummary, sharedFiles),
    error: task.error,
    childSummary
  };
}

function summarizeTask(task: DelegatedTask, results: StageResult[]): string {
  if (task.status === "failed") return task.error ?? latestResultError(results) ?? "Task failed.";
  if (task.status === "cancelled") return task.error ?? "Task cancelled.";
  if (task.status === "interrupted") return task.error ?? "Task interrupted.";
  const resultSummary = (task.result as { summary?: unknown } | undefined)?.summary;
  if (typeof resultSummary === "string" && resultSummary.trim()) return resultSummary.trim();
  const stageSummary = results.map(result => result.summary).filter(Boolean).join("\n");
  if (stageSummary.trim()) return stageSummary.trim();
  if (task.status === "completed") return "Task completed.";
  if (task.status === "running") return "Task is running.";
  return "Task is pending.";
}

function nextSteps(task: DelegatedTask, changedFiles: string[], childSummary?: TaskResultSummary["childSummary"], sharedFiles: string[] = []): string[] {
  const guardrailSteps = guardrailNextSteps(task);
  if (task.status === "failed") {
    return [
      ...guardrailSteps,
      task.verification?.status === "failed" ? "Review verification output, then retry or repair the task." : "Review the error and retry or resume the task.",
      changedFiles.length > 0 ? "Inspect changed files before rerunning verification." : ""
    ].filter(Boolean);
  }
  if (task.status === "completed") {
    return [
      ...guardrailSteps,
      task.verification?.status === "passed" && task.verification.repairTaskId ? `Completed after repair task ${task.verification.repairTaskId}; inspect the repair diff before trusting the result.` : "",
      sharedFiles.length > 0 ? `Inspect shared files touched by multiple workflow children: ${sharedFiles.slice(0, 8).join(", ")}${sharedFiles.length > 8 ? ", ..." : ""}` : "",
      changedFiles.length > 0 ? "Review changed files and keep or revert the task output as needed." : "Inspect the final output artifact for details.",
      task.verification?.status === "passed" ? "Verification passed; the workspace is ready for manual review." : task.verifyCommand ? "Run or inspect the verification command result." : "",
      childSummary && childSummary.failed > 0 ? "Retry failed workflow parts before trusting the workflow result." : ""
    ].filter(Boolean);
  }
  if (task.status === "running") return ["Watch Live I/O and verification status until the task finishes."];
  if (task.status === "pending") return ["Wait for dependencies or queue capacity before inspecting output."];
  return ["Retry or resume the task when ready."];
}

function guardrailNextSteps(task: DelegatedTask): string[] {
  const guardrails = task.guardrails ?? [];
  if (guardrails.length === 0) return [];
  const errors = guardrails.filter(issue => issue.severity === "error");
  const warnings = guardrails.filter(issue => issue.severity === "warning");
  return [
    errors.length > 0 ? `Resolve guardrail failures before trusting this task: ${errors.map(issue => issue.kind).join(", ")}.` : "",
    warnings.length > 0 ? `Review guardrail warnings: ${warnings.map(issue => issue.kind).join(", ")}.` : ""
  ].filter(Boolean);
}

function assessQuality(
  task: DelegatedTask,
  changedFiles: string[],
  childSummary?: TaskResultSummary["childSummary"]
): TaskResultSummary["quality"] {
  const reasons: string[] = [];
  const guardrails = task.guardrails ?? [];
  const guardrailErrors = guardrails.filter(issue => issue.severity === "error");
  const guardrailWarnings = guardrails.filter(issue => issue.severity === "warning");

  if (task.status === "failed" || task.verification?.status === "failed" || guardrailErrors.length > 0 || (childSummary?.failed ?? 0) > 0) {
    if (task.verification?.status === "failed") reasons.push("Verification failed.");
    if (guardrailErrors.length > 0) reasons.push(`Guardrail errors: ${guardrailErrors.map(issue => issue.kind).join(", ")}.`);
    if ((childSummary?.failed ?? 0) > 0) reasons.push(`${childSummary?.failed ?? 0} workflow child task(s) failed.`);
    if (reasons.length === 0) reasons.push(task.error ?? "Task failed.");
    return { status: "failed", score: 0, reasons };
  }

  if (task.status === "cancelled") return { status: "failed", score: 0, reasons: [task.error ?? "Task was cancelled."] };
  if (task.status === "interrupted") return { status: "failed", score: 0, reasons: [task.error ?? "Task was interrupted."] };
  if (task.status === "running" || task.status === "pending") {
    return { status: "partial", score: 40, reasons: [task.status === "running" ? "Task is still running." : "Task is pending."] };
  }

  if (task.status === "completed") {
    if (guardrailWarnings.length > 0) {
      return {
        status: "risky",
        score: 65,
        reasons: [`Guardrail warnings need review: ${guardrailWarnings.map(issue => issue.kind).join(", ")}.`]
      };
    }
    if (task.verification?.status === "passed") {
      const repaired = task.verification.repairTaskId ? [`Completed after repair task ${task.verification.repairTaskId}.`] : [];
      return { status: repaired.length > 0 ? "risky" : "success", score: repaired.length > 0 ? 80 : 95, reasons: ["Verification passed.", ...repaired] };
    }
    if (task.verifyCommand) {
      return { status: "partial", score: 55, reasons: ["Verification was requested but did not pass yet."] };
    }
    if (changedFiles.length > 0) return { status: "partial", score: 70, reasons: ["Task changed files but no verification result is recorded."] };
    return { status: "partial", score: 60, reasons: ["Task completed without changed files or verification evidence."] };
  }

  return { status: "partial", score: 50, reasons: ["Task result is not terminal."] };
}

function classifyFailure(
  task: DelegatedTask,
  childSummary?: TaskResultSummary["childSummary"]
): TaskResultSummary["failure"] | undefined {
  const errorText = [
    task.error,
    task.verification?.error,
    ...(task.guardrails ?? []).map(issue => `${issue.kind} ${issue.message} ${issue.evidence ?? ""}`)
  ].filter(Boolean).join("\n");
  const guardrailKinds = new Set((task.guardrails ?? []).map(issue => issue.kind));

  if (task.status === "completed" && task.verification?.status !== "failed" && !guardrailKinds.has("empty_output") && (childSummary?.failed ?? 0) === 0) return undefined;
  if (task.status === "cancelled") return failure("cancelled", task.error ?? "Task was cancelled.", "Retry the task when you are ready to run it again.");
  if (task.status === "interrupted") return failure("interrupted", task.error ?? "Task was interrupted.", "Resume the task if the agent session is available, otherwise retry it.");
  if (task.verification?.timedOut || /\b(timeout|timed out)\b/i.test(errorText)) {
    return failure("timeout", errorText || "Task timed out.", "Increase timeout, reduce task scope, or retry with a smaller batch.");
  }
  if (task.verification?.status === "failed") {
    return failure("verification_failed", task.verification.error ?? task.error ?? "Verification failed.", "Inspect verification output, then repair or retry the task.");
  }
  if (guardrailKinds.has("empty_output") || /empty output|no useful output/i.test(errorText)) {
    return failure("empty_output", errorText || "Agent returned empty output.", "Retry with a more explicit request or switch provider.");
  }
  if (/\b(eacces|eperm|permission denied|not allowed|denied)\b/i.test(errorText)) {
    return failure("permission", errorText, "Adjust the profile permission policy or run with an agent that has the required access.");
  }
  if (/\b(enoent|not found|command not found|missing|no such file|spawn .* enoent)\b/i.test(errorText)) {
    return failure("environment", errorText, "Install or configure the missing CLI/dependency, then retry.");
  }
  if ((childSummary?.failed ?? 0) > 0) {
    return failure("provider_failed", `${childSummary?.failed ?? 0} workflow child task(s) failed.`, "Retry failed workflow parts, then rerun review.");
  }
  if (task.status === "failed") {
    return failure("provider_failed", task.error ?? "Agent task failed.", "Check Live I/O and retry or resume with the latest agent session.");
  }
  return undefined;
}

function failure(category: NonNullable<TaskResultSummary["failure"]>["category"], message: string, nextAction: string): NonNullable<TaskResultSummary["failure"]> {
  return { category, message: message.trim() || category, nextAction };
}

function verificationSummary(task: DelegatedTask): TaskResultSummary["verification"] | undefined {
  const verification = task.verification;
  if (!verification) return undefined;
  return {
    command: verification.command,
    status: verification.status,
    exitCode: verification.exitCode,
    error: verification.error,
    tmpDir: verification.tmpDir,
    repairedBy: verification.repairTaskId
  };
}

function agentSessions(results: StageResult[], fallbackSessionId?: string): TaskResultSummary["agentSessions"] {
  const sessions: TaskResultSummary["agentSessions"] = results
    .filter(result => result.agentSessionId)
    .map(result => ({
      agent: result.agent,
      sessionId: String(result.agentSessionId),
      resumeCommand: result.resumeCommand
    }));
  if (sessions.length === 0 && fallbackSessionId) {
    const fallbackAgent = [...results].reverse().find(result => result.agent)?.agent ?? "claude";
    sessions.push({ agent: fallbackAgent, sessionId: fallbackSessionId });
  }
  return uniqueSessions(sessions);
}

function uniqueSessions(sessions: TaskResultSummary["agentSessions"]): TaskResultSummary["agentSessions"] {
  const seen = new Set<string>();
  return sessions.filter(session => {
    const key = `${session.agent}:${session.sessionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function providerAttempts(results: StageResult[], fallbackProvider?: DelegatedTask["preferredAgent"]): TaskResultSummary["providerAttempts"] {
  const attempts = uniqueAgents(results.map(result => result.agent));
  if (attempts.length > 0) return attempts;
  return fallbackProvider ? [fallbackProvider] : [];
}

function stageResults(task: DelegatedTask): StageResult[] {
  const results = (task.result as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(results)) return [];
  return results.filter(isStageResult);
}

function isStageResult(result: unknown): result is StageResult {
  if (typeof result !== "object" || result === null) return false;
  const candidate = result as Partial<StageResult>;
  return typeof candidate.stage === "string" && typeof candidate.agent === "string";
}

function latestResultError(results: StageResult[]): string | undefined {
  return [...results].reverse().find(result => result.error)?.error;
}

function summarizeChildren(children: DelegatedTask[]): NonNullable<TaskResultSummary["childSummary"]> {
  return {
    total: children.length,
    completed: children.filter(child => child.status === "completed").length,
    failed: children.filter(child => child.status === "failed" || child.status === "cancelled" || child.status === "interrupted").length,
    running: children.filter(child => child.status === "running").length,
    pending: children.filter(child => child.status === "pending").length
  };
}

function durationMs(task: DelegatedTask): number {
  const created = Date.parse(task.createdAt);
  const updated = Date.parse(task.updatedAt);
  return Number.isFinite(created) && Number.isFinite(updated) ? Math.max(0, updated - created) : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueAgents(values: AgentName[]): AgentName[] {
  return [...new Set(values)];
}

function sharedChangedFiles(children: Array<{ id: string; files: string[] }>): string[] {
  const owners = new Map<string, Set<string>>();
  for (const child of children) {
    for (const file of unique(child.files)) {
      if (!owners.has(file)) owners.set(file, new Set());
      owners.get(file)?.add(child.id);
    }
  }
  return [...owners.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([file]) => file);
}
