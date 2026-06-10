import type { AgentName, TaskExecutionPreviewStep, TaskMode, TaskPreview, TaskPreviewWarning } from "../types.js";
import type { ProviderCheck } from "../doctor/ProviderDoctor.js";

export interface BuildTaskPreviewInput {
  workspace: string;
  request?: string;
  command?: string;
  strategy?: "auto" | "direct" | "plan";
  stage?: "plan" | "implement" | "review" | "analyze";
  profile?: string;
  mode?: TaskMode;
  preferredAgent?: AgentName;
  verifyCommand?: string;
  workspaceExists?: boolean;
  providerChecks?: Array<Pick<ProviderCheck, "provider" | "status" | "error">>;
  git?: {
    supported: boolean;
    clean: boolean;
    status?: string[];
    error?: string;
  };
}

export function buildTaskPreview(input: BuildTaskPreviewInput): TaskPreview {
  const strategy = resolvePreviewStrategy(input);
  const warnings = previewWarnings(input, strategy);
  const score = riskScore(warnings, input, strategy);
  return {
    strategy,
    risk: {
      level: score >= 70 ? "high" : score >= 35 ? "medium" : "low",
      score
    },
    executionPlan: executionPlan(input, strategy),
    willModifyFiles: willModifyFiles(input, strategy),
    verification: {
      configured: Boolean(input.verifyCommand?.trim()),
      command: input.verifyCommand?.trim() || undefined
    },
    warnings,
    recommendedAction: recommendedAction(warnings, strategy),
    recommendedSetup: recommendedSetup(input, warnings, strategy)
  };
}

function resolvePreviewStrategy(input: BuildTaskPreviewInput): TaskPreview["strategy"] {
  const command = String(input.command || "").trim();
  if (command === "/ultrawork" || command.includes("ultrawork")) return "ultrawork";
  if (command === "/plan-work") return "create_plan";
  if (command === "/execute-plan") return "execute_plan";
  if (input.strategy === "direct" || input.strategy === "plan") return input.strategy;
  const request = String(input.request || "").toLowerCase();
  const planSignals = [
    "先计划",
    "先规划",
    "先设计",
    "写计划",
    "制定计划",
    "规划再",
    "plan first",
    "create a plan",
    "write a plan",
    "design first",
    "complex",
    "复杂",
    "多步骤",
    "重构",
    "架构"
  ];
  return planSignals.some(signal => request.includes(signal)) ? "plan" : "direct";
}

function executionPlan(input: BuildTaskPreviewInput, strategy: TaskPreview["strategy"]): TaskExecutionPreviewStep[] {
  const provider = input.preferredAgent;
  if (strategy === "ultrawork") {
    return [
      { role: "planner", stage: "plan", provider: provider ?? "claude", profile: "planner" },
      { role: "executor", stage: "implement", provider, profile: "multi-coder", count: 6 },
      { role: "reviewer", stage: "review", profile: "momus" },
      { role: "workflow verification", stage: "workflow" }
    ];
  }
  if (strategy === "plan") {
    return [
      { role: "planner", stage: "plan", provider: provider ?? "claude", profile: "planner" },
      { role: "executor", stage: "implement", provider, profile: "coder" }
    ];
  }
  if (strategy === "create_plan") return [{ role: "planner", stage: "plan", provider: provider ?? "claude", profile: "planner" }];
  if (strategy === "execute_plan") return [{ role: "executor", stage: "implement", provider, profile: input.profile || "coder" }];
  return [{ role: input.profile || "coder", stage: input.stage ?? "implement", provider, profile: input.profile || "coder" }];
}

function previewWarnings(input: BuildTaskPreviewInput, strategy: TaskPreview["strategy"]): TaskPreviewWarning[] {
  const warnings: TaskPreviewWarning[] = [];
  if (input.workspaceExists === false) {
    warnings.push({ code: "workspace_missing", severity: "error", message: "Workspace path does not exist. Create it before running or choose an existing project." });
  }
  if (input.git?.supported === false) {
    warnings.push({ code: "not_git", severity: "info", message: "Workspace is not a git repository, so rollback and dirty-state protection will be limited." });
  } else if (input.git && !input.git.clean) {
    warnings.push({ code: "dirty_workspace", severity: "warning", message: `Workspace has uncommitted changes${input.git.status?.length ? ` (${input.git.status.length} file(s))` : ""}; rollback may be unavailable.` });
  }
  const selectedProvider = input.preferredAgent;
  const unavailable = selectedProvider ? input.providerChecks?.find(check => check.provider === selectedProvider && check.status !== "ready") : undefined;
  if (unavailable) {
    warnings.push({ code: "provider_unavailable", severity: "error", message: `${selectedProvider} is ${unavailable.status}: ${unavailable.error ?? "provider check failed"}` });
  }
  if (!input.verifyCommand?.trim() && strategy !== "create_plan") {
    warnings.push({ code: "no_verification", severity: strategy === "direct" ? "warning" : "warning", message: "No verify command is configured; completed work will be harder to trust automatically." });
  }
  if (String(input.request || "").length > 1200 || /大型|完整|复杂|系统|database|数据库|架构/i.test(String(input.request || ""))) {
    warnings.push({ code: "large_request", severity: strategy === "direct" ? "warning" : "info", message: "Request looks broad; planning or ultrawork is safer than a single direct task." });
  }
  if (input.mode === "sync" && (strategy === "ultrawork" || strategy === "plan")) {
    warnings.push({ code: "sync_long_task", severity: "warning", message: "Long workflows should run in background mode so status and output remain inspectable." });
  }
  return warnings;
}

function riskScore(warnings: TaskPreviewWarning[], input: BuildTaskPreviewInput, strategy: TaskPreview["strategy"]): number {
  const warningScore = warnings.reduce((total, warning) => total + (warning.severity === "error" ? 45 : warning.severity === "warning" ? 20 : 8), 0);
  const strategyScore = strategy === "ultrawork" ? 12 : strategy === "plan" ? 8 : 0;
  const modificationScore = willModifyFiles(input, strategy) ? 8 : 0;
  return Math.min(100, warningScore + strategyScore + modificationScore);
}

function willModifyFiles(input: BuildTaskPreviewInput, strategy: TaskPreview["strategy"]): boolean {
  if (strategy === "create_plan") return false;
  if (input.stage === "plan" || input.stage === "review" || input.stage === "analyze") return false;
  return true;
}

function recommendedAction(warnings: TaskPreviewWarning[], strategy: TaskPreview["strategy"]): string {
  if (warnings.some(warning => warning.code === "workspace_missing")) return "Create or choose the workspace path before running.";
  if (warnings.some(warning => warning.code === "provider_unavailable")) return "Fix provider availability or switch Agent to Auto before running.";
  if (warnings.some(warning => warning.code === "dirty_workspace")) return "Commit, stash, or consciously accept existing workspace changes before running.";
  if (warnings.some(warning => warning.code === "no_verification") && strategy !== "create_plan") return "Add a verify command if this task changes code.";
  if (strategy === "ultrawork") return "Run as background ultrawork and inspect child plan progress.";
  if (strategy === "plan") return "Create a plan first, then execute it as a background task.";
  return "Run the task.";
}

function recommendedSetup(
  input: BuildTaskPreviewInput,
  warnings: TaskPreviewWarning[],
  strategy: TaskPreview["strategy"]
): TaskPreview["recommendedSetup"] {
  const notes: string[] = [];
  const providerUnavailable = warnings.some(warning => warning.code === "provider_unavailable");
  const dirtyWorkspace = warnings.some(warning => warning.code === "dirty_workspace");
  const broadRequest = warnings.some(warning => warning.code === "large_request");
  const setup: NonNullable<TaskPreview["recommendedSetup"]> = { notes };

  if (providerUnavailable) {
    setup.preferredAgent = "";
    notes.push("Switch Agent to Auto because the selected provider is unavailable.");
  }

  if (strategy === "ultrawork" || broadRequest) {
    setup.tab = "command";
    setup.command = "/ultrawork";
    setup.mode = "background";
    setup.strategy = "auto";
    notes.push("Use background ultrawork for broad or multi-step work.");
  } else if (strategy === "plan") {
    setup.tab = "auto";
    setup.mode = "background";
    setup.strategy = "plan";
    notes.push("Use plan strategy before implementation.");
  } else if (strategy === "create_plan") {
    setup.tab = "create-plan";
    setup.preferredAgent = setup.preferredAgent ?? input.preferredAgent ?? "";
    notes.push("Create a plan without modifying source files.");
  } else if (strategy === "execute_plan") {
    setup.tab = "execute-plan";
    setup.mode = "background";
    notes.push("Execute the selected saved plan in background mode.");
  } else {
    setup.tab = "command";
    setup.command = input.command || "/start-work";
    setup.mode = "background";
    setup.strategy = "auto";
    notes.push("Use a background direct task for small implementation work.");
  }

  if (dirtyWorkspace) {
    setup.requiresConfirmation = true;
    notes.push("Workspace is dirty; confirm before running or clean it first.");
  }
  if (!input.verifyCommand?.trim() && strategy !== "create_plan") {
    notes.push("Add a verify command when possible.");
  }

  return notes.length > 0 ? setup : undefined;
}
