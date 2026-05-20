import { readFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeCodeAgentOptions } from "../agents/ClaudeCodeAgent.js";
import { AgentRegistry } from "../agents/AgentRegistry.js";
import { ClaudeCodeAgent } from "../agents/ClaudeCodeAgent.js";
import { CodexAgent } from "../agents/CodexAgent.js";
import { loadBridgeConfig, type BridgeConfig } from "../config/BridgeConfig.js";
import { resolveSkills } from "../config/SkillResolver.js";
import type { AgentName, AgentProfileName, Stage, StageResult, TaskCategory, TaskMode } from "../types.js";
import { AgentCoordinator } from "../workflow/AgentCoordinator.js";
import { createPlanId, PlanStore, type PlanRecord } from "../workflow/PlanStore.js";
import { TaskManager } from "../workflow/TaskManager.js";
import type { TaskStore } from "../workflow/TaskStore.js";
import { readBackgroundOutput } from "./backgroundOutput.js";

export interface ClaudeRunStageArgs {
  stage: Stage;
  workspace: string;
  request: string;
  runId?: string;
  agentSessionId?: string;
  loadSkills?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface ClaudeRunStageToolOptions extends ClaudeCodeAgentOptions {
  config?: BridgeConfig;
}

export interface DelegateTaskArgs {
  mode?: TaskMode;
  stages?: Stage[];
  stage?: Stage;
  workspace: string;
  request: string;
  category?: TaskCategory;
  profile?: AgentProfileName;
  autoCategory?: boolean;
  preferredAgent?: AgentName;
  runId?: string;
  agentSessionId?: string;
  loadSkills?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface CreatePlanArgs {
  workspace: string;
  request: string;
  planId?: string;
  plannerProfile?: AgentProfileName;
  preferredAgent?: AgentName;
  loadSkills?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface ExecutePlanArgs {
  mode?: TaskMode;
  workspace: string;
  planId?: string;
  planPath?: string;
  request?: string;
  executorProfile?: AgentProfileName;
  preferredAgent?: AgentName;
  runId?: string;
  agentSessionId?: string;
  loadSkills?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface TaskLookupArgs {
  taskId: string;
  maxBytes?: number;
  cursor?: number;
}

export interface TaskToolSet {
  delegateTaskTool(args: DelegateTaskArgs): Promise<CallToolResult>;
  createPlanTool(args: CreatePlanArgs): Promise<CallToolResult>;
  executePlanTool(args: ExecutePlanArgs): Promise<CallToolResult>;
  taskStatusTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskCancelTool(args: TaskLookupArgs): Promise<CallToolResult>;
  backgroundOutputTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskListTool(): Promise<CallToolResult>;
  agentCatalogTool(): Promise<CallToolResult>;
}

export async function runClaudeStageTool(
  args: ClaudeRunStageArgs,
  options: ClaudeRunStageToolOptions = {}
): Promise<CallToolResult> {
  const validationError = validateArgs(args);
  if (validationError) return errorResult(validationError);

  try {
    const { config = loadBridgeConfig(), ...agentOptions } = options;
    const skills = await resolveSkills(args.loadSkills, config);
    const agent = new ClaudeCodeAgent({
      claudePath: process.env.CLAUDE_CODE_PATH,
      ...agentOptions
    });
    const result = await agent.run({
      stage: args.stage,
      agent: "claude",
      workspace: args.workspace,
      request: args.request,
      runId: args.runId,
      agentSessionId: args.agentSessionId,
      model: args.model,
      effort: args.effort,
      timeoutMs: args.timeoutMs,
      skills
    });

    return {
      content: [
        {
          type: "text",
          text: formatStageResult(result)
        }
      ],
      structuredContent: { ...result },
      isError: result.ok ? undefined : true
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

export function createTaskTools(options: { claude?: ClaudeCodeAgentOptions; config?: BridgeConfig; taskStore?: TaskStore } = {}): TaskToolSet {
  const config = options.config ?? loadBridgeConfig();
  const registry = new AgentRegistry(config);
  const coordinator = new AgentCoordinator({
    registry,
    providers: {
      claude: new ClaudeCodeAgent({
        claudePath: process.env.CLAUDE_CODE_PATH ?? config.claudePath,
        ...options.claude
      }),
      codex: new CodexAgent()
    }
  });
  const manager = new TaskManager(coordinator, options.taskStore, { concurrency: config.concurrency });

  return {
    async delegateTaskTool(args: DelegateTaskArgs): Promise<CallToolResult> {
      const validationError = validateDelegateArgs(args, registry);
      if (validationError) return errorResult(validationError);

      try {
        const profile = args.profile ? registry.getProfile(args.profile) : undefined;
        const explicitStages = args.stages ?? (args.stage ? [args.stage] : undefined);
        const inferredCategory = args.category ?? (
          !args.profile && !args.preferredAgent && args.autoCategory !== false
            ? registry.classifyTask({ request: args.request, stages: explicitStages ?? [] })
            : undefined
        );
        const stages = explicitStages ?? profile?.stages ?? defaultStagesForCategory(inferredCategory);
        const skills = await resolveSkills(args.loadSkills, config);
        const result = await manager.run({
          mode: args.mode ?? "sync",
          workspace: args.workspace,
          request: args.request,
          stages,
          routing: {},
          category: inferredCategory,
          profile: args.profile,
          autoCategory: false,
          preferredAgent: args.preferredAgent,
          runId: args.runId,
          agentSessionId: args.agentSessionId,
          model: args.model,
          effort: args.effort,
          timeoutMs: args.timeoutMs ?? config.defaults?.timeoutMs,
          skills
        });
        return {
          content: [{ type: "text", text: formatDelegateResult(result) }],
          structuredContent: {
            ok: result.mode === "sync" ? result.result?.ok === true : true,
            ...result
          },
          isError: result.mode === "sync" && result.result?.ok === false ? true : undefined
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },

    async createPlanTool(args: CreatePlanArgs): Promise<CallToolResult> {
      const validationError = validateCreatePlanArgs(args, registry);
      if (validationError) return errorResult(validationError);

      try {
        const planId = args.planId ?? createPlanId();
        const skills = await resolveSkills(args.loadSkills, config);
        const result = await manager.run({
          mode: "sync",
          workspace: args.workspace,
          request: buildPlannerRequest(args.request),
          stages: ["plan"],
          routing: {},
          profile: args.plannerProfile,
          preferredAgent: args.preferredAgent ?? (args.plannerProfile ? undefined : "claude"),
          runId: `plan-${planId}`,
          model: args.model,
          effort: args.effort,
          timeoutMs: args.timeoutMs ?? config.defaults?.timeoutMs,
          skills
        });
        const stageResult = result.result?.results.at(-1);
        if (!result.result?.ok || !stageResult?.outputPath) {
          return errorResult(result.result?.summary ?? "Plan creation failed");
        }
        const planContent = await readFile(stageResult.outputPath, "utf8");
        const plan = await new PlanStore(args.workspace).write(planId, normalizePlanContent(planId, args.request, planContent));
        return {
          content: [{ type: "text", text: formatPlanCreated(plan, stageResult.runId) }],
          structuredContent: {
            ok: true,
            planId: plan.planId,
            planPath: plan.planPath,
            plannerRunId: stageResult.runId,
            plannerResult: stageResult
          }
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },

    async executePlanTool(args: ExecutePlanArgs): Promise<CallToolResult> {
      const validationError = validateExecutePlanArgs(args, registry);
      if (validationError) return errorResult(validationError);

      try {
        const plan = await new PlanStore(args.workspace).read({ planId: args.planId, planPath: args.planPath });
        const skills = await resolveSkills(args.loadSkills, config);
        const result = await manager.run({
          mode: args.mode ?? "sync",
          workspace: args.workspace,
          request: buildExecutorRequest(plan, args.request),
          stages: ["implement"],
          routing: {},
          profile: args.executorProfile ?? (args.preferredAgent ? undefined : "coder"),
          preferredAgent: args.preferredAgent,
          runId: args.runId ?? `exec-${plan.planId}`,
          agentSessionId: args.agentSessionId,
          planId: plan.planId,
          planPath: plan.planPath,
          model: args.model,
          effort: args.effort,
          timeoutMs: args.timeoutMs ?? config.defaults?.timeoutMs,
          skills
        });
        return {
          content: [{ type: "text", text: formatExecutePlanResult(result, plan) }],
          structuredContent: {
            ok: result.mode === "sync" ? result.result?.ok === true : true,
            planId: plan.planId,
            planPath: plan.planPath,
            ...result
          },
          isError: result.mode === "sync" && result.result?.ok === false ? true : undefined
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },

    async taskStatusTool(args: TaskLookupArgs): Promise<CallToolResult> {
      if (!args.taskId) return errorResult("taskId is required");
      const task = manager.get(args.taskId);
      if (!task) return errorResult(`Task not found: ${args.taskId}`);
      return {
        content: [{ type: "text", text: formatTask(task) }],
        structuredContent: { ok: true, ...task }
      };
    },

    async taskCancelTool(args: TaskLookupArgs): Promise<CallToolResult> {
      if (!args.taskId) return errorResult("taskId is required");
      const task = manager.cancel(args.taskId);
      if (!task) return errorResult(`Task not found: ${args.taskId}`);
      return {
        content: [{ type: "text", text: formatTask(task) }],
        structuredContent: { ok: true, ...task }
      };
    },

    async backgroundOutputTool(args: TaskLookupArgs): Promise<CallToolResult> {
      if (!args.taskId) return errorResult("taskId is required");
      const task = manager.get(args.taskId);
      if (!task) return errorResult(`Task not found: ${args.taskId}`);
      const output = await readBackgroundOutput(task, args.maxBytes, args.cursor);
      return {
        content: [{ type: "text", text: formatBackgroundOutput(output) }],
        structuredContent: { ok: true, ...output }
      };
    },

    async taskListTool(): Promise<CallToolResult> {
      const tasks = manager.list();
      return {
        content: [{ type: "text", text: tasks.length === 0 ? "No background tasks." : tasks.map(formatTask).join("\n\n") }],
        structuredContent: { ok: true, tasks }
      };
    },

    async agentCatalogTool(): Promise<CallToolResult> {
      const catalog = {
        agents: registry.listAgents(),
        categories: registry.listCategories(),
        profiles: registry.listProfiles()
      };
      return {
        content: [{ type: "text", text: formatCatalog(catalog) }],
        structuredContent: { ok: true, ...catalog }
      };
    }
  };
}

function validateArgs(args: ClaudeRunStageArgs): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.request) return "request is required";
  if (!isStage(args.stage)) return `invalid stage: ${String(args.stage)}`;
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  if (args.agentSessionId !== undefined && !isUuid(args.agentSessionId)) return "agentSessionId must be a Claude session UUID";
  return undefined;
}

function validateDelegateArgs(args: DelegateTaskArgs, registry = new AgentRegistry()): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.request) return "request is required";
  if (args.mode !== undefined && args.mode !== "sync" && args.mode !== "background") {
    return `invalid mode: ${String(args.mode)}`;
  }
  const stages = args.stages ?? (args.stage ? [args.stage] : ["plan"]);
  if (stages.length === 0) return "at least one stage is required";
  for (const stage of stages) {
    if (!isStage(stage)) return `invalid stage: ${String(stage)}`;
  }
  if (args.preferredAgent !== undefined && args.preferredAgent !== "claude" && args.preferredAgent !== "codex") {
    return `invalid preferredAgent: ${String(args.preferredAgent)}`;
  }
  if (args.profile !== undefined) {
    if (!registry.getProfile(args.profile)) return `invalid profile: ${String(args.profile)}`;
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  if (args.agentSessionId !== undefined && !isUuid(args.agentSessionId)) return "agentSessionId must be a Claude session UUID";
  return undefined;
}

function validateCreatePlanArgs(args: CreatePlanArgs, registry = new AgentRegistry()): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.request) return "request is required";
  if (args.plannerProfile !== undefined && !registry.getProfile(args.plannerProfile)) {
    return `invalid plannerProfile: ${String(args.plannerProfile)}`;
  }
  if (args.preferredAgent !== undefined && args.preferredAgent !== "claude" && args.preferredAgent !== "codex") {
    return `invalid preferredAgent: ${String(args.preferredAgent)}`;
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  return undefined;
}

function validateExecutePlanArgs(args: ExecutePlanArgs, registry = new AgentRegistry()): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.planId && !args.planPath) return "planId or planPath is required";
  if (args.mode !== undefined && args.mode !== "sync" && args.mode !== "background") {
    return `invalid mode: ${String(args.mode)}`;
  }
  if (args.executorProfile !== undefined && !registry.getProfile(args.executorProfile)) {
    return `invalid executorProfile: ${String(args.executorProfile)}`;
  }
  if (args.preferredAgent !== undefined && args.preferredAgent !== "claude" && args.preferredAgent !== "codex") {
    return `invalid preferredAgent: ${String(args.preferredAgent)}`;
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  if (args.agentSessionId !== undefined && !isUuid(args.agentSessionId)) return "agentSessionId must be a Claude session UUID";
  return undefined;
}

function isStage(value: unknown): value is Stage {
  return value === "plan" || value === "implement" || value === "review" || value === "analyze";
}

function buildPlannerRequest(request: string): string {
  return [
    "Create an implementation plan for the request below.",
    "Do not modify files. Return a concise markdown plan with goal, constraints, steps, verification, and risks.",
    "",
    "## Request",
    request
  ].join("\n");
}

function buildExecutorRequest(plan: PlanRecord, request?: string): string {
  return [
    "Execute the implementation plan below. Keep changes scoped to the plan. Do not commit.",
    request ? `Additional request: ${request}` : undefined,
    "",
    `Plan file: ${plan.planPath}`,
    "",
    plan.content
  ].filter((line): line is string => line !== undefined).join("\n");
}

function normalizePlanContent(planId: string, request: string, content: string): string {
  return [
    `# Plan ${planId}`,
    "",
    "## Original request",
    request,
    "",
    "## Implementation plan",
    content.trim(),
    ""
  ].join("\n");
}

function formatStageResult(result: StageResult): string {
  const lines = [
    result.summary,
    `Run: ${result.runId}`,
    `Stage: ${result.stage}`,
    `Status: ${result.status}`
  ];

  if (result.outputPath) lines.push(`Output: ${result.outputPath}`);
  if (result.logPath) lines.push(`Log: ${result.logPath}`);
  if (result.agentSessionId) lines.push(`Agent session: ${result.agentSessionId}`);
  if (result.agentTranscriptPath) lines.push(`Agent transcript: ${result.agentTranscriptPath}`);
  if (result.resumeCommand) lines.push(`Resume: ${result.resumeCommand}`);
  if (result.changedFiles.length > 0) lines.push(`Changed files: ${result.changedFiles.join(", ")}`);
  if (result.error) lines.push(`Error: ${result.error}`);

  return lines.join("\n");
}

function formatPlanCreated(plan: PlanRecord, plannerRunId: string): string {
  return [
    "Plan created",
    `Plan: ${plan.planId}`,
    `Path: ${plan.planPath}`,
    `Planner run: ${plannerRunId}`
  ].join("\n");
}

function formatExecutePlanResult(result: Awaited<ReturnType<TaskManager["run"]>>, plan: PlanRecord): string {
  return [
    result.mode === "background" ? "Plan execution launched" : "Plan execution completed",
    `Plan: ${plan.planId}`,
    `Path: ${plan.planPath}`,
    result.mode === "background" ? `Task: ${result.taskId}` : `Run: ${result.result?.runId}`,
    result.mode === "background" ? `Status: ${result.task?.status ?? "pending"}` : `Status: ${result.result?.ok ? "completed" : "failed"}`,
    result.mode === "sync" ? result.result?.summary : undefined
  ].filter(Boolean).join("\n");
}

function formatDelegateResult(result: Awaited<ReturnType<TaskManager["run"]>>): string {
  if (result.mode === "background") {
    return [
      "Background task launched",
      `Task: ${result.taskId}`,
      `Status: ${result.task?.status ?? "pending"}`,
      result.task?.runId ? `Run: ${result.task.runId}` : undefined
    ].filter(Boolean).join("\n");
  }
  return [
    "Synchronous task completed",
    `Run: ${result.result?.runId}`,
    `Status: ${result.result?.ok ? "completed" : "failed"}`,
    result.result?.summary
  ].filter(Boolean).join("\n");
}

function formatTask(task: { id: string; status: string; runId: string; updatedAt: string; planId?: string; planPath?: string; error?: string }): string {
  return [
    `Task: ${task.id}`,
    `Run: ${task.runId}`,
    `Status: ${task.status}`,
    task.planId ? `Plan: ${task.planId}` : undefined,
    task.planPath ? `Plan path: ${task.planPath}` : undefined,
    `Updated: ${task.updatedAt}`,
    task.error ? `Error: ${task.error}` : undefined
  ].filter(Boolean).join("\n");
}

function formatBackgroundOutput(output: Awaited<ReturnType<typeof readBackgroundOutput>>): string {
  const lines = [
    formatTask(output.task),
    "",
    ...output.artifacts.flatMap(artifact => [
      `Artifact: ${artifact.path}`,
      artifact.content || "(empty)",
      ""
    ])
  ];
  if (output.transcript) {
    lines.push(`Transcript: ${output.transcript.path}`, output.transcript.tail || "(empty)");
  }
  if (output.transcriptSummary) {
    lines.push(...[
      "",
      "Transcript summary",
      output.transcriptSummary.sessionId ? `Session: ${output.transcriptSummary.sessionId}` : undefined,
      output.transcriptSummary.models.length > 0 ? `Models: ${output.transcriptSummary.models.join(", ")}` : undefined,
      `Tool calls: ${output.transcriptSummary.toolCalls.length}`,
      output.transcriptSummary.fileWrites.length > 0 ? `File writes: ${output.transcriptSummary.fileWrites.join(", ")}` : undefined
    ].filter((line): line is string => Boolean(line)));
  }
  if (output.events.length > 0) {
    lines.push("", `Incremental events: cursor ${output.cursor} -> ${output.nextCursor}`);
    for (const event of output.events) {
      lines.push(`Event: ${event.source} ${event.path} @${event.offset}`, event.content);
    }
  }
  return lines.join("\n").trim();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function defaultStagesForCategory(category: TaskCategory | undefined): Stage[] {
  if (category === "coding" || category === "heavy") return ["implement"];
  if (category === "review") return ["review"];
  if (category === "analysis") return ["analyze"];
  return ["plan"];
}

function formatCatalog(catalog: {
  agents: ReturnType<AgentRegistry["listAgents"]>;
  categories: ReturnType<AgentRegistry["listCategories"]>;
  profiles: ReturnType<AgentRegistry["listProfiles"]>;
}): string {
  return [
    "Agents",
    ...catalog.agents.map(agent => `- ${agent.name}: ${agent.description}`),
    "",
    "Categories",
    ...catalog.categories.map(category => `- ${category.name}: ${category.agent} - ${category.description}`),
    "",
    "Profiles",
    ...catalog.profiles.map(profile => `- ${profile.name}: ${profile.agent}/${profile.category} - ${profile.description}`)
  ].join("\n");
}

function errorResult(message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    structuredContent: {
      ok: false,
      error: message
    },
    isError: true
  };
}
