import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeCodeAgentOptions } from "../agents/ClaudeCodeAgent.js";
import { AgentRegistry } from "../agents/AgentRegistry.js";
import { ClaudeCodeAgent } from "../agents/ClaudeCodeAgent.js";
import { CodexCliAgent, GeminiCliAgent, MyFlickerAgent, OpenCodeAgent } from "../agents/CliCodeAgent.js";
import { CodexAgent } from "../agents/CodexAgent.js";
import {
  inspectCodeDefinition,
  inspectCodeDiagnostics,
  inspectCodeReferences,
  inspectCodeSymbols,
  type CodeDiagnosticsArgs,
  type CodeLocation,
  type CodePositionArgs,
  type CodeSymbol,
  type CodeSymbolsArgs
} from "../code/CodeIntelligence.js";
import { CommandRegistry, parseCommandText, type CommandDefinition } from "../commands/CommandRegistry.js";
import { loadBridgeConfig, type BridgeConfig } from "../config/BridgeConfig.js";
import { resolveSkills } from "../config/SkillResolver.js";
import { buildWorkspaceContext } from "../context/WorkspaceContext.js";
import { ProviderDoctor } from "../doctor/ProviderDoctor.js";
import type { AgentName, AgentProfileName, AgentTeam, DelegatedTask, Effort, Stage, StageResult, TaskCategory, TaskMode, TaskPreview, TeamBudget, TeamMember, TeamMessage, TeamTask, TeamTaskStatus } from "../types.js";
import { createGitCheckpoint } from "../utils/git.js";
import { buildWebVerifyCommand } from "../verification/WebAppVerifier.js";
import { AgentCoordinator } from "../workflow/AgentCoordinator.js";
import { createPlanId, PlanStore, type PlanRecord } from "../workflow/PlanStore.js";
import { ProjectMemoryStore, renderProjectMemoryMarkdown } from "../workflow/ProjectMemory.js";
import { TaskManager } from "../workflow/TaskManager.js";
import { buildTaskPreview } from "../workflow/TaskPreview.js";
import { TeamStore } from "../workflow/TeamStore.js";
import type { TaskStore } from "../workflow/TaskStore.js";
import { readBackgroundOutput } from "./backgroundOutput.js";

export interface ClaudeRunStageArgs {
  stage: Stage;
  workspace: string;
  request: string;
  runId?: string;
  agentSessionId?: string;
  preferredAgent?: AgentName;
  loadSkills?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  verifyCommand?: string;
  maxRepairAttempts?: number;
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
  verifyCommand?: string;
  maxRepairAttempts?: number;
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
  verifyCommand?: string;
  maxRepairAttempts?: number;
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
  verifyCommand?: string;
  maxRepairAttempts?: number;
}

export type AutoDispatchStrategy = "auto" | "direct" | "plan";

export interface AutoDispatchArgs {
  workspace: string;
  request: string;
  mode?: TaskMode;
  strategy?: AutoDispatchStrategy;
  planId?: string;
  runId?: string;
  agentSessionId?: string;
  preferredAgent?: AgentName;
  loadSkills?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  verifyCommand?: string;
  maxRepairAttempts?: number;
}

export interface TaskLookupArgs {
  taskId: string;
  maxBytes?: number;
  cursor?: number;
}

export interface ProjectMemoryArgs {
  workspace: string;
}

export interface RunCommandArgs {
  command: string;
  workspace: string;
  request?: string;
  mode?: TaskMode;
  strategy?: AutoDispatchStrategy;
  planId?: string;
  planPath?: string;
  runId?: string;
  agentSessionId?: string;
  preferredAgent?: AgentName;
  loadSkills?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  verifyCommand?: string;
  maxRepairAttempts?: number;
}

export interface TaskPreviewArgs {
  command?: string;
  workspace: string;
  request?: string;
  mode?: TaskMode;
  strategy?: AutoDispatchStrategy;
  stage?: Stage;
  profile?: AgentProfileName;
  preferredAgent?: AgentName;
  verifyCommand?: string;
}

export interface TeamCreateArgs {
  teamId?: string;
  workspace: string;
  goal: string;
  lead?: string;
  template?: string;
  autoStart?: boolean;
  autoMerge?: boolean;
  budget?: TeamBudget;
  members?: Array<{
    id?: string;
    role: string;
    profile?: string;
    agent?: AgentName;
    summary?: string;
  }>;
}

export interface TeamCreateFromTemplateArgs {
  teamId?: string;
  template: string;
  workspace: string;
  goal: string;
  autoStart?: boolean;
  autoMerge?: boolean;
  budget?: TeamBudget;
}

export interface TeamCoordinatorRunArgs {
  teamId: string;
  autoStart?: boolean;
  autoMerge?: boolean;
  maxStarts?: number;
}

export interface TeamRoundRunArgs {
  teamId: string;
  topic?: string;
  participants?: string[];
  maxParticipants?: number;
}

export interface TeamMessageArgs {
  teamId: string;
  from: string;
  to?: string;
  body: string;
  taskId?: string;
}

export interface TeamInboxArgs {
  teamId: string;
  memberId: string;
}

export interface TeamTaskCreateArgs {
  teamId: string;
  title: string;
  description?: string;
  assignee?: string;
  linkedTaskId?: string;
}

export interface TeamTaskUpdateArgs {
  teamId: string;
  taskId: string;
  status?: TeamTaskStatus;
  assignee?: string;
  linkedTaskId?: string;
  description?: string;
}

export interface TeamTaskStartArgs {
  teamId: string;
  taskId: string;
  stage?: Stage;
  profile?: AgentProfileName;
  preferredAgent?: AgentName;
  mode?: TaskMode;
  request?: string;
  verifyCommand?: string;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  maxRepairAttempts?: number;
  loadSkills?: string[];
}

export interface TeamStatusArgs {
  teamId: string;
}

export interface TaskToolSet {
  providerDoctorTool(): Promise<CallToolResult>;
  commandCatalogTool(): Promise<CallToolResult>;
  taskPreviewTool(args: TaskPreviewArgs): Promise<CallToolResult>;
  runCommandTool(args: RunCommandArgs): Promise<CallToolResult>;
  autoDispatchTool(args: AutoDispatchArgs): Promise<CallToolResult>;
  delegateTaskTool(args: DelegateTaskArgs): Promise<CallToolResult>;
  createPlanTool(args: CreatePlanArgs): Promise<CallToolResult>;
  executePlanTool(args: ExecutePlanArgs): Promise<CallToolResult>;
  taskStatusTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskCancelTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskRetryTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskResumeTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskRollbackTool(args: TaskLookupArgs): Promise<CallToolResult>;
  backgroundOutputTool(args: TaskLookupArgs): Promise<CallToolResult>;
  projectMemoryTool(args: ProjectMemoryArgs): Promise<CallToolResult>;
  teamCreateTool(args: TeamCreateArgs): Promise<CallToolResult>;
  teamTemplatesTool(): Promise<CallToolResult>;
  teamCreateFromTemplateTool(args: TeamCreateFromTemplateArgs): Promise<CallToolResult>;
  teamCoordinatorRunTool(args: TeamCoordinatorRunArgs): Promise<CallToolResult>;
  teamRoundRunTool(args: TeamRoundRunArgs): Promise<CallToolResult>;
  teamSendMessageTool(args: TeamMessageArgs): Promise<CallToolResult>;
  teamInboxTool(args: TeamInboxArgs): Promise<CallToolResult>;
  teamTaskCreateTool(args: TeamTaskCreateArgs): Promise<CallToolResult>;
  teamTaskUpdateTool(args: TeamTaskUpdateArgs): Promise<CallToolResult>;
  teamTaskStartTool(args: TeamTaskStartArgs): Promise<CallToolResult>;
  teamStatusTool(args: TeamStatusArgs): Promise<CallToolResult>;
  teamListTool(): Promise<CallToolResult>;
  taskListTool(): Promise<CallToolResult>;
  agentCatalogTool(): Promise<CallToolResult>;
  codeSymbolsTool(args: CodeSymbolsArgs): Promise<CallToolResult>;
  codeDefinitionTool(args: CodePositionArgs): Promise<CallToolResult>;
  codeReferencesTool(args: CodePositionArgs): Promise<CallToolResult>;
  codeDiagnosticsTool(args: CodeDiagnosticsArgs): Promise<CallToolResult>;
}

interface TeamTemplateDefinition {
  name: string;
  description: string;
  members: NonNullable<TeamCreateArgs["members"]>;
  tasks: Array<{ title: string; description?: string; assignee?: string }>;
  budget: TeamBudget;
}

const teamTemplates: Record<string, TeamTemplateDefinition> = {
  "bugfix-team": {
    name: "bugfix-team",
    description: "Investigate, implement, and review a bug fix.",
    members: [
      { id: "investigator", role: "root cause analysis", profile: "analyst", agent: "codex-cli" },
      { id: "coder", role: "implementation", profile: "coder", agent: "claude" },
      { id: "reviewer", role: "review", profile: "reviewer", agent: "codex-cli" },
      { id: "merger", role: "merge and stabilization", profile: "coder", agent: "claude" }
    ],
    tasks: [
      { title: "Find the root cause and affected files", assignee: "investigator" },
      { title: "Implement the smallest correct fix", assignee: "coder" },
      { title: "Review the fix and verification result", assignee: "reviewer" }
    ],
    budget: { maxRunning: 2, maxTasks: 8, maxRepairAttempts: 1, allowedAgents: ["claude", "codex-cli", "codex"] }
  },
  "frontend-team": {
    name: "frontend-team",
    description: "Build or refine a frontend feature with review.",
    members: [
      { id: "designer", role: "frontend planning", profile: "planner", agent: "codex-cli" },
      { id: "frontend", role: "frontend implementation", profile: "coder", agent: "claude" },
      { id: "reviewer", role: "ux and code review", profile: "reviewer", agent: "codex-cli" },
      { id: "merger", role: "integration", profile: "coder", agent: "claude" }
    ],
    tasks: [
      { title: "Plan the user flow, layout, and component changes", assignee: "designer" },
      { title: "Implement the frontend feature", assignee: "frontend" },
      { title: "Review responsive behavior, usability, and code quality", assignee: "reviewer" }
    ],
    budget: { maxRunning: 2, maxTasks: 8, maxRepairAttempts: 1, allowedAgents: ["claude", "codex-cli", "gemini", "codex"] }
  },
  "backend-team": {
    name: "backend-team",
    description: "Design, implement, and verify a backend change.",
    members: [
      { id: "architect", role: "backend design", profile: "planner", agent: "codex-cli" },
      { id: "backend", role: "backend implementation", profile: "coder", agent: "claude" },
      { id: "tester", role: "verification", profile: "reviewer", agent: "codex-cli" },
      { id: "merger", role: "integration", profile: "coder", agent: "claude" }
    ],
    tasks: [
      { title: "Design the backend approach and identify contracts", assignee: "architect" },
      { title: "Implement the backend change", assignee: "backend" },
      { title: "Verify behavior and failure cases", assignee: "tester" }
    ],
    budget: { maxRunning: 2, maxTasks: 8, maxRepairAttempts: 1, allowedAgents: ["claude", "codex-cli", "myflicker", "codex"] }
  },
  "research-team": {
    name: "research-team",
    description: "Analyze a codebase or topic without editing by default.",
    members: [
      { id: "researcher", role: "code exploration", profile: "analyst", agent: "codex-cli" },
      { id: "librarian", role: "documentation synthesis", profile: "analyst", agent: "gemini" },
      { id: "reviewer", role: "accuracy review", profile: "reviewer", agent: "codex-cli" }
    ],
    tasks: [
      { title: "Explore the codebase and identify key modules", assignee: "researcher" },
      { title: "Synthesize findings into a structured report", assignee: "librarian" },
      { title: "Review the report for gaps and incorrect claims", assignee: "reviewer" }
    ],
    budget: { maxRunning: 2, maxTasks: 6, maxRepairAttempts: 0, allowedAgents: ["codex-cli", "gemini", "codex"] }
  },
  "large-refactor-team": {
    name: "large-refactor-team",
    description: "Plan, split, implement, merge, and review a larger refactor.",
    members: [
      { id: "planner", role: "refactor planning", profile: "planner", agent: "codex-cli" },
      { id: "coder-a", role: "implementation slice A", profile: "coder", agent: "claude" },
      { id: "coder-b", role: "implementation slice B", profile: "coder", agent: "myflicker" },
      { id: "merger", role: "merge and consistency", profile: "coder", agent: "claude" },
      { id: "reviewer", role: "final review", profile: "reviewer", agent: "codex-cli" }
    ],
    tasks: [
      { title: "Create a safe refactor plan and identify independent slices", assignee: "planner" },
      { title: "Implement the first refactor slice", assignee: "coder-a" },
      { title: "Implement the second refactor slice", assignee: "coder-b" },
      { title: "Review final behavior and integration risk", assignee: "reviewer" }
    ],
    budget: { maxRunning: 3, maxTasks: 10, maxRepairAttempts: 1, allowedAgents: ["claude", "codex-cli", "myflicker", "codex"] }
  },
  "release-team": {
    name: "release-team",
    description: "Prepare release checks, documentation, and final review.",
    members: [
      { id: "checker", role: "release verification", profile: "reviewer", agent: "codex-cli" },
      { id: "docs", role: "release notes", profile: "analyst", agent: "gemini" },
      { id: "fixer", role: "release fixes", profile: "coder", agent: "claude" }
    ],
    tasks: [
      { title: "Run release checks and identify blockers", assignee: "checker" },
      { title: "Draft release notes and user-facing changes", assignee: "docs" },
      { title: "Fix release blockers if any are found", assignee: "fixer" }
    ],
    budget: { maxRunning: 2, maxTasks: 8, maxRepairAttempts: 1, allowedAgents: ["claude", "codex-cli", "gemini", "codex"] }
  }
};

export async function runClaudeStageTool(
  args: ClaudeRunStageArgs,
  options: ClaudeRunStageToolOptions = {}
): Promise<CallToolResult> {
  const validationError = validateArgs(args);
  if (validationError) return errorResult(validationError);

  try {
    const { config = loadBridgeConfig(), ...agentOptions } = options;
    const skills = await resolveSkills(args.loadSkills, config);
    const workspaceContext = await buildWorkspaceContext({ workspace: args.workspace });
    const agent = new ClaudeCodeAgent({
      claudePath: process.env.CLAUDE_CODE_PATH ?? config.claudePath,
      defaultModel: config.defaults?.claudeModel,
      ...agentOptions
    });
    const result = await agent.run({
      stage: args.stage,
      agent: "claude",
      workspace: args.workspace,
      request: args.request,
      workspaceContext,
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

export function createTaskTools(options: {
  claude?: ClaudeCodeAgentOptions;
  config?: BridgeConfig;
  taskStore?: TaskStore;
  taskManager?: TaskManager;
  teamStore?: TeamStore;
} = {}): TaskToolSet {
  const config = options.config ?? loadBridgeConfig();
  const registry = new AgentRegistry(config);
  const commandRegistry = new CommandRegistry(config);
  const manager = options.taskManager ?? createTaskManager({ config, registry, claude: options.claude, taskStore: options.taskStore });
  const teamStore = options.teamStore ?? new TeamStore();

  function syncLinkedTeamTasks(team: AgentTeam | undefined): AgentTeam | undefined {
    if (!team) return undefined;
    let current = team;
    for (const teamTask of team.tasks) {
      if (!teamTask.linkedTaskId) continue;
      const linkedTask = manager.get(teamTask.linkedTaskId);
      if (!linkedTask) continue;
      const nextStatus = teamStatusForDelegatedTask(linkedTask);
      if (nextStatus === teamTask.status) continue;
      const updated = teamStore.updateTask({ teamId: team.id, taskId: teamTask.id, status: nextStatus });
      if (updated) {
        teamStore.sendMessage({
          teamId: team.id,
          from: "system",
          to: teamTask.assignee ?? "all",
          taskId: teamTask.id,
          body: `Linked delegated task ${linkedTask.id} is now ${linkedTask.status}; team task marked ${nextStatus}.`
        });
      }
      current = teamStore.get(team.id) ?? current;
    }
    return current;
  }

  function linkedTasksFor(team: AgentTeam): Array<Pick<DelegatedTask, "id" | "status" | "request" | "workspace" | "preferredAgent" | "profile" | "updatedAt" | "resultSummary" | "runtime">> {
    return team.tasks
      .map(teamTask => teamTask.linkedTaskId ? manager.get(teamTask.linkedTaskId) : undefined)
      .filter((task): task is DelegatedTask => task !== undefined)
      .map(task => ({
        id: task.id,
        status: task.status,
        request: task.request,
        workspace: task.workspace,
        preferredAgent: task.preferredAgent,
        profile: task.profile,
        updatedAt: task.updatedAt,
        resultSummary: task.resultSummary,
        runtime: task.runtime
      }));
  }

  async function startTeamTask(args: TeamTaskStartArgs): Promise<CallToolResult> {
    if (!args.teamId) return errorResult("teamId is required");
    if (!args.taskId) return errorResult("taskId is required");
    const team = syncLinkedTeamTasks(teamStore.get(args.teamId));
    if (!team) return errorResult(`Team not found: ${args.teamId}`);
    const teamTask = team.tasks.find(task => task.id === args.taskId);
    if (!teamTask) return errorResult(`Team task not found: ${args.teamId}/${args.taskId}`);
    if (teamTask.linkedTaskId) return errorResult(`Team task is already linked to delegated task: ${teamTask.linkedTaskId}`);
    const assignee = team.members.find(member => member.id === teamTask.assignee);
    const profile = args.profile ?? (assignee?.profile as AgentProfileName | undefined);
    if (profile && !registry.getProfile(profile)) return errorResult(`unknown profile: ${profile}`);
    const preferredAgent = args.preferredAgent ?? assignee?.agent;
    if (preferredAgent && !registry.getAgent(preferredAgent)) return errorResult(`unknown preferredAgent: ${preferredAgent}`);
    const budgetError = validateTeamBudgetForStart(team, preferredAgent, manager);
    if (budgetError) return errorResult(budgetError);
    const explicitStages = args.stage ? [args.stage] : undefined;
    const inferredCategory = !profile && !preferredAgent
      ? registry.classifyTask({ request: teamTask.title, stages: explicitStages ?? [] })
      : undefined;
    const resolvedProfile = profile ? registry.getProfile(profile) : undefined;
    const stages = explicitStages ?? resolvedProfile?.stages ?? defaultStagesForCategory(inferredCategory);
    const skills = await resolveSkills(args.loadSkills, config);
    const request = buildTeamTaskRequest(team, teamTask, args.request);
    const result = await manager.run({
      mode: args.mode ?? "background",
      workspace: team.workspace,
      request,
      stages,
      routing: {},
      category: inferredCategory,
      profile,
      autoCategory: false,
      preferredAgent,
      model: args.model,
      effort: args.effort,
      timeoutMs: args.timeoutMs ?? config.defaults?.timeoutMs,
      verifyCommand: args.verifyCommand,
      maxRepairAttempts: args.maxRepairAttempts ?? team.budget?.maxRepairAttempts,
      skills
    });
    const linkedTaskId = result.task?.id;
    const linkedStatus: TeamTaskStatus = result.mode === "sync"
      ? (result.result?.ok === true ? "done" : "blocked")
      : "in_progress";
    const updated = linkedTaskId
      ? teamStore.updateTask({ teamId: team.id, taskId: teamTask.id, status: linkedStatus, linkedTaskId })
      : teamTask;
    if (linkedTaskId) {
      teamStore.sendMessage({
        teamId: team.id,
        from: team.lead,
        to: teamTask.assignee ?? "all",
        taskId: teamTask.id,
        body: `Started delegated task ${linkedTaskId} for team task ${teamTask.id}.`
      });
    }
    return {
      content: [{ type: "text", text: [
        `Team task started: ${teamTask.id}`,
        `Team: ${team.id}`,
        linkedTaskId ? `Delegated task: ${linkedTaskId}` : "Delegated task: -",
        updated ? `Status: ${updated.status}` : ""
      ].filter(Boolean).join("\n") }],
      structuredContent: {
        ok: result.mode === "sync" ? result.result?.ok === true : true,
        team,
        teamTask: updated,
        delegatedTaskId: linkedTaskId,
        delegatedTask: result.task,
        result
      },
      isError: result.mode === "sync" && result.result?.ok === false ? true : undefined
    };
  }

  function createTeamFromTemplate(args: TeamCreateFromTemplateArgs): AgentTeam | undefined {
    const template = teamTemplates[args.template];
    if (!template) return undefined;
    const team = teamStore.create({
      id: args.teamId,
      workspace: args.workspace,
      goal: args.goal,
      template: template.name,
      budget: { ...template.budget, ...args.budget },
      coordinator: {
        enabled: true,
        autoStart: args.autoStart ?? false,
        autoMerge: args.autoMerge ?? true,
        phase: "idle"
      },
      members: template.members
    });
    for (const task of template.tasks) {
      teamStore.createTask({ teamId: team.id, ...task });
    }
    return teamStore.get(team.id) ?? team;
  }

  async function runTeamCoordinator(args: TeamCoordinatorRunArgs): Promise<CallToolResult> {
    let team = syncLinkedTeamTasks(teamStore.get(args.teamId));
    if (!team) return errorResult(`Team not found: ${args.teamId}`);
    const autoStart = args.autoStart ?? team.coordinator?.autoStart ?? true;
    const autoMerge = args.autoMerge ?? team.coordinator?.autoMerge ?? true;
    const maxStarts = Math.max(0, args.maxStarts ?? team.budget?.maxRunning ?? 1);
    const actions: string[] = [];
    const startedTaskIds: string[] = [];

    if (autoStart) {
      for (const task of team.tasks.filter(item => item.status === "todo" && !item.linkedTaskId).slice(0, maxStarts)) {
        const start = await startTeamTask({ teamId: team.id, taskId: task.id, mode: "background" });
        if (start.isError) {
          const message = String(start.content[0]?.type === "text" ? start.content[0].text : "failed to start team task");
          actions.push(message);
          break;
        }
        const delegatedTaskId = (start.structuredContent as { delegatedTaskId?: string }).delegatedTaskId;
        startedTaskIds.push(task.id);
        actions.push(`Started ${task.id}${delegatedTaskId ? ` -> ${delegatedTaskId}` : ""}`);
        team = syncLinkedTeamTasks(teamStore.get(team.id)) ?? team;
      }
    }

    const activeTeam = syncLinkedTeamTasks(teamStore.get(team.id)) ?? team;
    const mergerTaskId = activeTeam.coordinator?.mergerTaskId;
    const nonMergerTasks = activeTeam.tasks.filter(task => task.id !== mergerTaskId);
    const allBaseDone = nonMergerTasks.length > 0 && nonMergerTasks.every(task => task.status === "done");
    let finalTeam = activeTeam;

    if (autoMerge && allBaseDone && !mergerTaskId) {
      const merger = teamStore.createTask({
        teamId: activeTeam.id,
        title: "Merge and stabilize completed team work",
        assignee: activeTeam.members.some(member => member.id === "merger") ? "merger" : activeTeam.lead,
        description: buildMergerTaskDescription(activeTeam)
      });
      if (merger) {
        teamStore.updateCoordinator(activeTeam.id, {
          enabled: true,
          autoStart,
          autoMerge,
          phase: "merging",
          mergerTaskId: merger.id,
          lastAction: `Created merger task ${merger.id}`
        });
        const started = await startTeamTask({
          teamId: activeTeam.id,
          taskId: merger.id,
          mode: "background",
          request: "Merge completed task outputs, resolve integration conflicts, keep behavior coherent, and report verification gaps."
        });
        const delegatedTaskId = (started.structuredContent as { delegatedTaskId?: string } | undefined)?.delegatedTaskId;
        actions.push(`Created merger task ${merger.id}${delegatedTaskId ? ` -> ${delegatedTaskId}` : ""}`);
      }
    }

    finalTeam = syncLinkedTeamTasks(teamStore.get(activeTeam.id)) ?? activeTeam;
    const phase = phaseForTeam(finalTeam);
    finalTeam = teamStore.updateCoordinator(finalTeam.id, {
      enabled: true,
      autoStart,
      autoMerge,
      phase,
      lastAction: actions.at(-1) ?? "No action needed"
    }) ?? finalTeam;

    return {
      content: [{ type: "text", text: [
        `Team coordinator: ${finalTeam.id}`,
        `Phase: ${phase}`,
        `Started: ${startedTaskIds.length}`,
        actions.length > 0 ? `Actions:\n- ${actions.join("\n- ")}` : "Actions: none"
      ].join("\n") }],
      structuredContent: {
        ok: true,
        team: finalTeam,
        phase,
        actions,
        startedTaskIds,
        linkedTasks: linkedTasksFor(finalTeam)
      }
    };
  }

  async function runTeamRound(args: TeamRoundRunArgs): Promise<CallToolResult> {
    const team = syncLinkedTeamTasks(teamStore.get(args.teamId));
    if (!team) return errorResult(`Team not found: ${args.teamId}`);
    const requestedParticipants = new Set((args.participants ?? []).map(item => item.trim()).filter(Boolean));
    const candidates = requestedParticipants.size > 0
      ? team.members.filter(member => requestedParticipants.has(member.id))
      : team.members;
    const maxParticipants = Math.max(1, args.maxParticipants ?? candidates.length);
    const participants = candidates.slice(0, maxParticipants);
    if (participants.length === 0) return errorResult("No matching team round participants.");

    const roundNumber = team.messages.filter(message => message.roundId).reduce((max, message) => {
      const match = /-round-(\d+)$/.exec(message.roundId ?? "");
      return Math.max(max, match ? Number(match[1]) : 0);
    }, 0) + 1;
    const roundId = `${team.id}-round-${roundNumber}`;
    const topic = args.topic?.trim() || team.coordinator?.lastAction || team.goal;
    const messages = participants.map((member, index) => teamStore.sendMessage({
      teamId: team.id,
      from: member.id,
      to: "all",
      roundId,
      body: buildTeamRoundMessage({ team, member, topic, roundId, index, participantCount: participants.length })
    })).filter((message): message is TeamMessage => Boolean(message));

    const phase = phaseForTeam(team) === "idle" ? "running" : phaseForTeam(team);
    teamStore.updateCoordinator(team.id, {
      enabled: true,
      autoStart: team.coordinator?.autoStart ?? false,
      autoMerge: team.coordinator?.autoMerge ?? true,
      phase,
      lastAction: `Ran communication round ${roundId}`,
      lastRoundId: roundId
    });
    const finalTeam = syncLinkedTeamTasks(teamStore.get(team.id)) ?? team;

    return {
      content: [{ type: "text", text: [
        `Team round: ${roundId}`,
        `Team: ${team.id}`,
        `Topic: ${topic}`,
        `Participants: ${participants.map(member => member.id).join(", ")}`,
        messages.length > 0 ? `Messages:\n- ${messages.map(message => `${message.from}: ${message.body}`).join("\n- ")}` : "Messages: none"
      ].join("\n") }],
      structuredContent: {
        ok: true,
        team: finalTeam,
        round: {
          id: roundId,
          topic,
          participantCount: participants.length,
          messages
        },
        linkedTasks: linkedTasksFor(finalTeam)
      }
    };
  }

  return {
    async providerDoctorTool(): Promise<CallToolResult> {
      const result = await new ProviderDoctor({ config }).check();
      return {
        content: [{ type: "text", text: formatProviderDoctor(result) }],
        structuredContent: { ...result }
      };
    },

    async commandCatalogTool(): Promise<CallToolResult> {
      const commands = commandRegistry.list();
      return {
        content: [{ type: "text", text: formatCommandCatalog(commands) }],
        structuredContent: { ok: true, commands }
      };
    },

    async taskPreviewTool(args: TaskPreviewArgs): Promise<CallToolResult> {
      const validationError = validateTaskPreviewArgs(args);
      if (validationError) return errorResult(validationError);
      try {
        const preview = await runTaskPreview(args, config);
        return {
          content: [{ type: "text", text: formatTaskPreview(preview) }],
          structuredContent: { ok: true, preview }
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },

    async runCommandTool(args: RunCommandArgs): Promise<CallToolResult> {
      const validationError = validateRunCommandArgs(args);
      if (validationError) return errorResult(validationError);

      try {
        const parsed = parseCommandText(args.command);
        const command = commandRegistry.get(parsed.name);
        if (!command) return errorResult(`Unknown command: ${parsed.name}`);
        const request = buildCommandRequest(command, args.request ?? parsed.request);
        if (command.action !== "execute_plan" && !request) return errorResult("request is required");
        const common = {
          workspace: args.workspace,
          request,
          mode: args.mode ?? command.mode,
          runId: args.runId,
          agentSessionId: args.agentSessionId,
          preferredAgent: args.preferredAgent ?? command.preferredAgent,
          loadSkills: args.loadSkills ?? command.loadSkills,
          model: args.model,
          effort: args.effort,
          timeoutMs: args.timeoutMs,
          verifyCommand: args.verifyCommand,
          maxRepairAttempts: args.maxRepairAttempts
        };

        let result: CallToolResult;
        if (command.action === "auto_dispatch") {
          result = await runAutoDispatch({
            ...common,
            request: request ?? "",
            strategy: args.strategy ?? command.strategy,
            planId: args.planId
          }, config, manager);
        } else if (command.action === "delegate_task") {
          const stages = command.stages ?? (command.stage ? [command.stage] : undefined);
          const skills = await resolveSkills(common.loadSkills, config);
          const delegated = await manager.run({
            mode: common.mode ?? "background",
            workspace: common.workspace,
            request: common.request ?? "",
            stages: stages ?? ["implement"],
            routing: {},
            profile: command.profile,
            preferredAgent: common.preferredAgent,
            runId: common.runId,
            agentSessionId: common.agentSessionId,
            model: common.model,
            effort: common.effort,
            timeoutMs: common.timeoutMs ?? config.defaults?.timeoutMs,
            verifyCommand: common.verifyCommand,
            maxRepairAttempts: common.maxRepairAttempts,
            skills
          });
          result = {
            content: [{ type: "text", text: formatDelegateResult(delegated) }],
            structuredContent: {
              ok: delegated.mode === "sync" ? delegated.result?.ok === true : true,
              ...delegated
            },
            isError: delegated.mode === "sync" && delegated.result?.ok === false ? true : undefined
          };
        } else if (command.action === "create_plan") {
          result = await runCreatePlan({
            workspace: common.workspace,
            request: common.request ?? "",
            planId: args.planId,
            plannerProfile: command.plannerProfile,
            preferredAgent: common.preferredAgent,
            loadSkills: common.loadSkills,
            model: common.model,
            effort: common.effort,
            timeoutMs: common.timeoutMs,
            verifyCommand: common.verifyCommand,
            maxRepairAttempts: common.maxRepairAttempts
          }, config, manager);
        } else if (command.action === "ultrawork") {
          result = await runUltraworkCommand({
            workspace: common.workspace,
            request: common.request ?? "",
            mode: common.mode ?? "background",
            planId: args.planId,
            runId: common.runId,
            agentSessionId: common.agentSessionId,
            plannerProfile: command.plannerProfile,
            executorProfile: command.executorProfile ?? "multi-coder",
            preferredAgent: common.preferredAgent,
            loadSkills: common.loadSkills,
            model: common.model,
            effort: common.effort,
            timeoutMs: common.timeoutMs,
            verifyCommand: common.verifyCommand,
            maxRepairAttempts: common.maxRepairAttempts
          }, config, manager);
        } else {
          result = await runExecutePlan({
            mode: common.mode,
            workspace: common.workspace,
            planId: args.planId,
            planPath: args.planPath,
            request: common.request,
            executorProfile: command.executorProfile,
            preferredAgent: common.preferredAgent,
            runId: common.runId,
            agentSessionId: common.agentSessionId,
            loadSkills: common.loadSkills,
            model: common.model,
            effort: common.effort,
            timeoutMs: common.timeoutMs,
            verifyCommand: common.verifyCommand,
            maxRepairAttempts: common.maxRepairAttempts
          }, config, manager);
        }
        return decorateCommandResult(result, command.name);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },

    async autoDispatchTool(args: AutoDispatchArgs): Promise<CallToolResult> {
      const validationError = validateAutoDispatchArgs(args);
      if (validationError) return errorResult(validationError);

      return runAutoDispatch(args, config, manager);
    },

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
          verifyCommand: args.verifyCommand,
          maxRepairAttempts: args.maxRepairAttempts,
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
          verifyCommand: args.verifyCommand,
          maxRepairAttempts: args.maxRepairAttempts,
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

    async taskRetryTool(args: TaskLookupArgs): Promise<CallToolResult> {
      if (!args.taskId) return errorResult("taskId is required");
      const result = await manager.retry(args.taskId);
      if (!result) return errorResult(`Task not found: ${args.taskId}`);
      return {
        content: [{ type: "text", text: formatDelegateResult(result) }],
        structuredContent: {
          ok: true,
          ...result
        }
      };
    },

    async taskResumeTool(args: TaskLookupArgs): Promise<CallToolResult> {
      if (!args.taskId) return errorResult("taskId is required");
      const result = await manager.resume(args.taskId);
      if (!result) return errorResult(`Task not found or no Claude session available: ${args.taskId}`);
      return {
        content: [{ type: "text", text: formatDelegateResult(result) }],
        structuredContent: {
          ok: true,
          ...result
        }
      };
    },

    async taskRollbackTool(args: TaskLookupArgs): Promise<CallToolResult> {
      if (!args.taskId) return errorResult("taskId is required");
      const task = await manager.rollback(args.taskId);
      if (!task) return errorResult(`Task not found or cannot be rolled back: ${args.taskId}`);
      return {
        content: [{ type: "text", text: formatTask(task) }],
        structuredContent: { ok: task.rollback?.status !== "failed", ...task },
        isError: task.rollback?.status === "failed" ? true : undefined
      };
    },

    async backgroundOutputTool(args: TaskLookupArgs): Promise<CallToolResult> {
      if (!args.taskId) return errorResult("taskId is required");
      const task = manager.get(args.taskId);
      if (!task) return errorResult(`Task not found: ${args.taskId}`);
      const output = await readBackgroundOutput(task, args.maxBytes, args.cursor, taskId => manager.get(taskId));
      return {
        content: [{ type: "text", text: formatBackgroundOutput(output) }],
        structuredContent: { ok: true, ...output }
      };
    },

    async projectMemoryTool(args: ProjectMemoryArgs): Promise<CallToolResult> {
      if (!args.workspace) return errorResult("workspace is required");
      const store = new ProjectMemoryStore(args.workspace);
      const memory = await store.read();
      const markdown = renderProjectMemoryMarkdown(memory);
      return {
        content: [{ type: "text", text: markdown }],
        structuredContent: {
          ok: true,
          ...memory,
          jsonPath: store.jsonPath,
          markdownPath: store.markdownPath,
          markdown
        }
      };
    },

    async teamTemplatesTool(): Promise<CallToolResult> {
      const templates = Object.values(teamTemplates);
      return {
        content: [{ type: "text", text: templates.map(template => `${template.name}: ${template.description}`).join("\n") }],
        structuredContent: { ok: true, templates }
      };
    },

    async teamCreateFromTemplateTool(args: TeamCreateFromTemplateArgs): Promise<CallToolResult> {
      if (!args.workspace) return errorResult("workspace is required");
      if (!args.goal) return errorResult("goal is required");
      if (!args.template) return errorResult("template is required");
      const team = createTeamFromTemplate(args);
      if (!team) return errorResult(`Unknown team template: ${args.template}`);
      let coordinator: CallToolResult | undefined;
      if (args.autoStart) coordinator = await runTeamCoordinator({ teamId: team.id, autoStart: true, autoMerge: args.autoMerge });
      const latest = syncLinkedTeamTasks(teamStore.get(team.id)) ?? team;
      return {
        content: [{ type: "text", text: [
          `Team created: ${latest.id}`,
          `Template: ${latest.template ?? args.template}`,
          `Tasks: ${latest.tasks.length}`,
          coordinator ? "Coordinator started." : "Coordinator idle."
        ].join("\n") }],
        structuredContent: {
          ok: true,
          team: latest,
          coordinator: coordinator?.structuredContent
        }
      };
    },

    async teamCoordinatorRunTool(args: TeamCoordinatorRunArgs): Promise<CallToolResult> {
      if (!args.teamId) return errorResult("teamId is required");
      return runTeamCoordinator(args);
    },

    async teamRoundRunTool(args: TeamRoundRunArgs): Promise<CallToolResult> {
      if (!args.teamId) return errorResult("teamId is required");
      return runTeamRound(args);
    },

    async teamCreateTool(args: TeamCreateArgs): Promise<CallToolResult> {
      const validationError = validateTeamCreateArgs(args);
      if (validationError) return errorResult(validationError);
      const team = teamStore.create({
        id: args.teamId,
        workspace: args.workspace,
        goal: args.goal,
        lead: args.lead,
        template: args.template,
        budget: args.budget,
        coordinator: {
          enabled: Boolean(args.autoStart || args.autoMerge),
          autoStart: Boolean(args.autoStart),
          autoMerge: Boolean(args.autoMerge),
          phase: "idle"
        },
        members: args.members
      });
      return {
        content: [{ type: "text", text: formatTeam(team) }],
        structuredContent: { ok: true, team }
      };
    },

    async teamSendMessageTool(args: TeamMessageArgs): Promise<CallToolResult> {
      const validationError = validateTeamMessageArgs(args);
      if (validationError) return errorResult(validationError);
      const message = teamStore.sendMessage(args);
      if (!message) return errorResult(`Team not found: ${args.teamId}`);
      return {
        content: [{ type: "text", text: formatTeamMessage(message) }],
        structuredContent: { ok: true, message }
      };
    },

    async teamInboxTool(args: TeamInboxArgs): Promise<CallToolResult> {
      if (!args.teamId) return errorResult("teamId is required");
      if (!args.memberId) return errorResult("memberId is required");
      const messages = teamStore.inbox(args.teamId, args.memberId);
      if (!messages) return errorResult(`Team not found: ${args.teamId}`);
      return {
        content: [{ type: "text", text: messages.length === 0 ? "No team messages." : messages.map(formatTeamMessage).join("\n\n") }],
        structuredContent: { ok: true, teamId: args.teamId, memberId: args.memberId, messages }
      };
    },

    async teamTaskCreateTool(args: TeamTaskCreateArgs): Promise<CallToolResult> {
      if (!args.teamId) return errorResult("teamId is required");
      if (!args.title) return errorResult("title is required");
      const task = teamStore.createTask(args);
      if (!task) return errorResult(`Team not found: ${args.teamId}`);
      return {
        content: [{ type: "text", text: formatTeamTask(task) }],
        structuredContent: { ok: true, task }
      };
    },

    async teamTaskUpdateTool(args: TeamTaskUpdateArgs): Promise<CallToolResult> {
      if (!args.teamId) return errorResult("teamId is required");
      if (!args.taskId) return errorResult("taskId is required");
      if (args.status !== undefined && !isTeamTaskStatus(args.status)) return errorResult(`invalid status: ${String(args.status)}`);
      const task = teamStore.updateTask(args);
      if (!task) return errorResult(`Team task not found: ${args.teamId}/${args.taskId}`);
      return {
        content: [{ type: "text", text: formatTeamTask(task) }],
        structuredContent: { ok: true, task }
      };
    },

    async teamTaskStartTool(args: TeamTaskStartArgs): Promise<CallToolResult> {
      return startTeamTask(args);
    },

    async teamStatusTool(args: TeamStatusArgs): Promise<CallToolResult> {
      if (!args.teamId) return errorResult("teamId is required");
      const team = syncLinkedTeamTasks(teamStore.get(args.teamId));
      if (!team) return errorResult(`Team not found: ${args.teamId}`);
      const linkedTasks = linkedTasksFor(team);
      return {
        content: [{ type: "text", text: formatTeam(team) }],
        structuredContent: { ok: true, team, linkedTasks }
      };
    },

    async teamListTool(): Promise<CallToolResult> {
      const teams = teamStore.list().map(team => syncLinkedTeamTasks(team) ?? team);
      return {
        content: [{ type: "text", text: teams.length === 0 ? "No teams." : teams.map(formatTeam).join("\n\n") }],
        structuredContent: { ok: true, teams, linkedTasks: teams.flatMap(linkedTasksFor) }
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
    },

    async codeSymbolsTool(args: CodeSymbolsArgs): Promise<CallToolResult> {
      try {
        const result = await inspectCodeSymbols(args);
        return {
          content: [{ type: "text", text: formatCodeSymbols(result.symbols) }],
          structuredContent: result
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },

    async codeDefinitionTool(args: CodePositionArgs): Promise<CallToolResult> {
      try {
        const result = await inspectCodeDefinition(args);
        return {
          content: [{ type: "text", text: formatCodeLocations("Definitions", result.definitions) }],
          structuredContent: result
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },

    async codeReferencesTool(args: CodePositionArgs): Promise<CallToolResult> {
      try {
        const result = await inspectCodeReferences(args);
        return {
          content: [{ type: "text", text: formatCodeLocations("References", result.references) }],
          structuredContent: result
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },

    async codeDiagnosticsTool(args: CodeDiagnosticsArgs): Promise<CallToolResult> {
      try {
        const result = await inspectCodeDiagnostics(args);
        return {
          content: [{ type: "text", text: formatCodeDiagnostics(result.diagnostics) }],
          structuredContent: result
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  };
}

export function createTaskManager(options: {
  config?: BridgeConfig;
  registry?: AgentRegistry;
  claude?: ClaudeCodeAgentOptions;
  taskStore?: TaskStore;
} = {}): TaskManager {
  const config = options.config ?? loadBridgeConfig();
  const registry = options.registry ?? new AgentRegistry(config);
  const coordinator = new AgentCoordinator({
    registry,
    providers: {
      claude: new ClaudeCodeAgent({
        claudePath: process.env.CLAUDE_CODE_PATH ?? config.claudePath,
        defaultModel: config.defaults?.claudeModel,
        ...options.claude
      }),
      "codex-cli": new CodexCliAgent({
        codexPath: process.env.CODEX_CLI_PATH ?? config.codexPath
      }),
      gemini: new GeminiCliAgent({
        geminiPath: process.env.GEMINI_CLI_PATH ?? config.geminiPath
      }),
      opencode: new OpenCodeAgent({
        opencodePath: process.env.OPENCODE_CLI_PATH ?? config.opencodePath
      }),
      myflicker: new MyFlickerAgent({
        myflickerPath: process.env.MYFLICKER_CLI_PATH ?? config.myflickerPath
      }),
      codex: new CodexAgent()
    }
  });
  return new TaskManager(coordinator, options.taskStore, {
    concurrency: config.concurrency,
    workflow: config.workflow
  });
}

async function runAutoDispatch(args: AutoDispatchArgs, config: BridgeConfig, manager: TaskManager): Promise<CallToolResult> {
  try {
    const strategy = resolveAutoDispatchStrategy(args);
    const skills = await resolveSkills(args.loadSkills, config);
    if (strategy === "direct") {
      const result = await manager.run({
        mode: args.mode ?? "background",
        workspace: args.workspace,
        request: args.request,
        stages: ["implement"],
        routing: {},
        profile: args.preferredAgent ? undefined : "coder",
        preferredAgent: args.preferredAgent,
        runId: args.runId,
        agentSessionId: args.agentSessionId,
        model: args.model,
        effort: args.effort,
        timeoutMs: args.timeoutMs ?? config.defaults?.timeoutMs,
        verifyCommand: args.verifyCommand,
        maxRepairAttempts: args.maxRepairAttempts,
        skills
      });
      return {
        content: [{ type: "text", text: formatAutoDispatchResult(strategy, "Direct implementation request routed to coder.", result) }],
        structuredContent: {
          ok: result.mode === "sync" ? result.result?.ok === true : true,
          strategy,
          reason: "Direct implementation request routed to coder.",
          ...result
        },
        isError: result.mode === "sync" && result.result?.ok === false ? true : undefined
      };
    }

    const planId = args.planId ?? createPlanId();
    const planResult = await manager.run({
      mode: "sync",
      workspace: args.workspace,
      request: buildPlannerRequest(args.request),
      stages: ["plan"],
      routing: {},
      preferredAgent: args.preferredAgent ?? "claude",
      runId: `plan-${planId}`,
      model: args.model,
      effort: args.effort,
      timeoutMs: args.timeoutMs ?? config.defaults?.timeoutMs,
      skills
    });
    const stageResult = planResult.result?.results.at(-1);
    if (!planResult.result?.ok || !stageResult?.outputPath) {
      return errorResult(planResult.result?.summary ?? "Auto dispatch plan creation failed");
    }
    const planContent = await readFile(stageResult.outputPath, "utf8");
    const plan = await new PlanStore(args.workspace).write(planId, normalizePlanContent(planId, args.request, planContent));
    const execution = await manager.run({
      mode: args.mode ?? "background",
      workspace: args.workspace,
      request: buildExecutorRequest(plan),
      stages: ["implement"],
      routing: {},
      profile: args.preferredAgent ? undefined : "coder",
      preferredAgent: args.preferredAgent,
      runId: args.runId ?? `exec-${plan.planId}`,
      agentSessionId: args.agentSessionId,
      planId: plan.planId,
      planPath: plan.planPath,
      model: args.model,
      effort: args.effort,
      timeoutMs: args.timeoutMs ?? config.defaults?.timeoutMs,
      verifyCommand: args.verifyCommand,
      maxRepairAttempts: args.maxRepairAttempts,
      skills
    });
    return {
      content: [{ type: "text", text: formatAutoDispatchResult(strategy, "Planning requested or inferred before implementation.", execution, plan) }],
      structuredContent: {
        ok: execution.mode === "sync" ? execution.result?.ok === true : true,
        strategy,
        reason: "Planning requested or inferred before implementation.",
        planId: plan.planId,
        planPath: plan.planPath,
        plannerRunId: stageResult.runId,
        plannerResult: stageResult,
        ...execution
      },
      isError: execution.mode === "sync" && execution.result?.ok === false ? true : undefined
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

async function runTaskPreview(args: TaskPreviewArgs, config: BridgeConfig): Promise<TaskPreview> {
  const [workspaceExists, doctor, git] = await Promise.all([
    pathExists(args.workspace),
    new ProviderDoctor({ config, cwd: args.workspace }).check().catch(() => undefined),
    createGitCheckpoint(args.workspace).catch(() => undefined)
  ]);
  return buildTaskPreview({
    workspace: args.workspace,
    request: args.request,
    command: args.command,
    mode: args.mode,
    strategy: args.strategy,
    stage: args.stage,
    profile: args.profile,
    preferredAgent: args.preferredAgent,
    verifyCommand: args.verifyCommand,
    workspaceExists,
    providerChecks: doctor?.checks,
    git
  });
}

async function runCreatePlan(args: CreatePlanArgs, config: BridgeConfig, manager: TaskManager): Promise<CallToolResult> {
  const skills = await resolveSkills(args.loadSkills, config);
  const planId = args.planId ?? createPlanId();
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
}

async function runUltraworkCommand(
  args: CreatePlanArgs & ExecutePlanArgs & { executorProfile: AgentProfileName },
  config: BridgeConfig,
  manager: TaskManager
): Promise<CallToolResult> {
  const verifyCommand = args.verifyCommand ?? buildWebVerifyCommand({
    workspace: args.workspace,
    request: args.request,
    cliPath: fileURLToPath(new URL("../cli.js", import.meta.url))
  });
  const planId = args.planId ?? createPlanId();
  const planResult = await runCreatePlan({
    workspace: args.workspace,
    request: args.request,
    planId,
    plannerProfile: args.plannerProfile,
    preferredAgent: args.preferredAgent,
    loadSkills: args.loadSkills,
    model: args.model,
    effort: args.effort,
    timeoutMs: args.timeoutMs
  }, config, manager);
  if (planResult.isError || planResult.structuredContent?.ok !== true) return planResult;
  const planPath = String(planResult.structuredContent.planPath ?? "");
  const plan = await new PlanStore(args.workspace).read({ planId, planPath });
  const maxImplementationTasks = config.workflow?.maxImplementationTasks ?? 6;
  const subtasks = extractPlanSubtasks(plan.content, maxImplementationTasks);
  const skills = await resolveSkills(args.loadSkills, config);
  const parentTaskId = args.runId ?? `ultrawork-${plan.planId}`;
  const childTaskIds: string[] = [];
  for (const [index, subtask] of subtasks.entries()) {
    const childRunId = `${parentTaskId}-part-${index + 1}`;
    childTaskIds.push(childRunId);
    await manager.run({
      mode: "background",
      workspace: args.workspace,
      request: buildSubtaskExecutorRequest(plan, subtask, index + 1, subtasks.length, args.request),
      stages: ["implement"],
      routing: {},
      profile: args.executorProfile,
      preferredAgent: args.preferredAgent,
      runId: childRunId,
      agentSessionId: args.agentSessionId,
      planId,
      planPath,
      parentTaskId,
      model: args.model,
      effort: args.effort,
      timeoutMs: args.timeoutMs ?? config.defaults?.timeoutMs,
      skills
    });
  }
  const reviewTaskId = `${parentTaskId}-review`;
  childTaskIds.push(reviewTaskId);
  await manager.run({
    mode: "background",
    workspace: args.workspace,
    request: buildWorkflowReviewRequest(plan, childTaskIds.filter(id => id !== reviewTaskId), args.request),
    stages: ["review"],
    routing: {},
    profile: "momus",
    preferredAgent: undefined,
    runId: reviewTaskId,
    planId,
    planPath,
    parentTaskId,
    dependsOnTaskIds: childTaskIds.filter(id => id !== reviewTaskId),
    model: args.model,
    effort: args.effort,
    timeoutMs: args.timeoutMs ?? config.defaults?.timeoutMs,
    skills
  });
  const workflowTask = manager.createWorkflowTask({
    id: parentTaskId,
    workspace: args.workspace,
    request: args.request,
    planId,
    planPath,
    childTaskIds,
    reviewTaskId,
    verifyCommand,
    maxRepairAttempts: args.maxRepairAttempts
  });
  return {
    content: [{
      type: "text",
      text: [
        "Ultrawork launched",
        `planId: ${planId}`,
        `planPath: ${planPath}`,
        `Implementation batches: ${subtasks.length}`,
        `Workflow concurrency: ${config.workflow?.maxRunning ?? 3}`,
        `Task: ${workflowTask.id}`,
        `Review task: ${reviewTaskId}`,
        `Child tasks: ${childTaskIds.join(", ")}`
      ].filter(Boolean).join("\n")
    }],
    structuredContent: {
      ok: true,
      planId,
      planPath,
      plannerRunId: planResult.structuredContent.plannerRunId,
      plannerResult: planResult.structuredContent.plannerResult,
      mode: "background",
      taskId: workflowTask.id,
      task: workflowTask,
      childTaskIds,
      reviewTaskId,
      workflowOptions: {
        maxImplementationTasks,
        maxRunning: config.workflow?.maxRunning ?? 3
      }
    }
  };
}

async function runExecutePlan(args: ExecutePlanArgs, config: BridgeConfig, manager: TaskManager): Promise<CallToolResult> {
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
    verifyCommand: args.verifyCommand,
    maxRepairAttempts: args.maxRepairAttempts,
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
}

function validateArgs(args: ClaudeRunStageArgs): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.request) return "request is required";
  if (!isStage(args.stage)) return `invalid stage: ${String(args.stage)}`;
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  if (args.preferredAgent !== undefined && !isAgent(args.preferredAgent)) {
    return `invalid preferredAgent: ${String(args.preferredAgent)}`;
  }
  if (args.agentSessionId !== undefined && !isUuid(args.agentSessionId)) return "agentSessionId must be a Claude session UUID";
  return undefined;
}

function validateRunCommandArgs(args: RunCommandArgs): string | undefined {
  if (!args.command) return "command is required";
  if (!args.workspace) return "workspace is required";
  if (args.mode !== undefined && args.mode !== "sync" && args.mode !== "background") {
    return `invalid mode: ${String(args.mode)}`;
  }
  if (args.strategy !== undefined && args.strategy !== "auto" && args.strategy !== "direct" && args.strategy !== "plan") {
    return `invalid strategy: ${String(args.strategy)}`;
  }
  if (args.preferredAgent !== undefined && !isAgent(args.preferredAgent)) {
    return `invalid preferredAgent: ${String(args.preferredAgent)}`;
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  const verificationError = validateVerificationArgs(args);
  if (verificationError) return verificationError;
  if (args.agentSessionId !== undefined && !isUuid(args.agentSessionId)) return "agentSessionId must be a Claude session UUID";
  return undefined;
}

function validateTaskPreviewArgs(args: TaskPreviewArgs): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (args.strategy !== undefined && args.strategy !== "auto" && args.strategy !== "direct" && args.strategy !== "plan") {
    return `invalid strategy: ${String(args.strategy)}`;
  }
  if (args.mode !== undefined && args.mode !== "sync" && args.mode !== "background") {
    return `invalid mode: ${String(args.mode)}`;
  }
  if (args.stage !== undefined && !isStage(args.stage)) return `invalid stage: ${String(args.stage)}`;
  if (args.preferredAgent !== undefined && !isAgent(args.preferredAgent)) {
    return `invalid preferredAgent: ${String(args.preferredAgent)}`;
  }
  return undefined;
}

function validateTeamCreateArgs(args: TeamCreateArgs): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.goal) return "goal is required";
  for (const member of args.members ?? []) {
    if (!member.role) return "member role is required";
    if (member.agent !== undefined && !isAgent(member.agent)) return `invalid member agent: ${String(member.agent)}`;
  }
  return undefined;
}

function validateTeamMessageArgs(args: TeamMessageArgs): string | undefined {
  if (!args.teamId) return "teamId is required";
  if (!args.from) return "from is required";
  if (!args.body) return "body is required";
  return undefined;
}

function buildTeamTaskRequest(team: AgentTeam, task: TeamTask, overrideRequest?: string): string {
  return [
    "Execute the assigned Team Mode task only.",
    "",
    `Team: ${team.id}`,
    `Team goal: ${team.goal}`,
    `Workspace: ${team.workspace}`,
    `Assigned task: ${task.id}`,
    `Title: ${task.title}`,
    task.description ? `Description: ${task.description}` : undefined,
    task.assignee ? `Assignee: ${task.assignee}` : undefined,
    overrideRequest ? `Extra instructions: ${overrideRequest}` : undefined,
    "",
    "Do not work on unrelated team tasks. Report what changed, what was verified, and any blocker."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function buildTeamRoundMessage(input: {
  team: AgentTeam;
  member: TeamMember;
  topic: string;
  roundId: string;
  index: number;
  participantCount: number;
}): string {
  const assigned = input.team.tasks.filter(task => task.assignee === input.member.id);
  const openAssigned = assigned.filter(task => task.status === "todo" || task.status === "in_progress");
  const blocked = input.team.tasks.filter(task => task.status === "blocked");
  const completed = input.team.tasks.filter(task => task.status === "done").length;
  const role = `${input.member.role}${input.member.profile ? `/${input.member.profile}` : ""}`;
  const nextTask = openAssigned[0] ?? input.team.tasks.find(task => task.status === "todo" || task.status === "in_progress");
  const prefix = `Round ${input.roundId}: as ${input.member.id} (${role}), topic "${input.topic}".`;
  const taskLine = nextTask
    ? `I am focused on ${nextTask.id}: ${nextTask.title} [${nextTask.status}].`
    : "I do not have an open assigned task right now.";
  if (/review|qa|test/i.test(role)) {
    return `${prefix} I will challenge assumptions, watch verification gaps, and review completed work. ${taskLine} Current board: ${completed} done, ${blocked.length} blocked.`;
  }
  if (/merge|integrat|stabili/i.test(role) || input.member.id === "merger") {
    return `${prefix} I will consolidate outputs, track shared-file conflicts, and turn unresolved items into follow-up tasks. Current board: ${completed} done, ${blocked.length} blocked.`;
  }
  if (/plan|design|analysis|investig/i.test(role)) {
    return `${prefix} I will clarify scope, dependencies, and risks before execution moves further. ${taskLine}`;
  }
  return `${prefix} I will execute my assigned slice and report changed files, verification, and blockers. ${taskLine}`;
}

function teamStatusForDelegatedTask(task: DelegatedTask): TeamTaskStatus {
  if (task.status === "completed") return "done";
  if (task.status === "failed" || task.status === "interrupted") return "blocked";
  if (task.status === "cancelled") return "cancelled";
  return "in_progress";
}

function validateTeamBudgetForStart(team: AgentTeam, preferredAgent: AgentName | undefined, manager: TaskManager): string | undefined {
  const budget = team.budget;
  if (!budget) return undefined;
  if (preferredAgent && budget.allowedAgents && !budget.allowedAgents.includes(preferredAgent)) {
    return `preferredAgent ${preferredAgent} is not allowed by team budget`;
  }
  if (budget.maxTasks !== undefined && team.tasks.length > budget.maxTasks) {
    return `team task count ${team.tasks.length} exceeds budget maxTasks ${budget.maxTasks}`;
  }
  if (budget.maxRuntimeMs !== undefined) {
    const created = Date.parse(team.createdAt);
    if (Number.isFinite(created) && Date.now() - created > budget.maxRuntimeMs) {
      return `team runtime exceeds budget maxRuntimeMs ${budget.maxRuntimeMs}`;
    }
  }
  if (budget.maxRunning !== undefined) {
    const running = team.tasks
      .map(task => task.linkedTaskId ? manager.get(task.linkedTaskId) : undefined)
      .filter((task): task is DelegatedTask => task !== undefined && (task.status === "running" || task.status === "pending"))
      .length;
    if (running >= budget.maxRunning) return `team running task budget reached: ${running}/${budget.maxRunning}`;
  }
  return undefined;
}

function buildMergerTaskDescription(team: AgentTeam): string {
  const completed = team.tasks
    .filter(task => task.status === "done")
    .map(task => `- ${task.id}: ${task.title}${task.linkedTaskId ? ` (${task.linkedTaskId})` : ""}`)
    .join("\n");
  return [
    "Merge and stabilize the completed Team Mode work.",
    "",
    "Completed tasks:",
    completed || "- none",
    "",
    "Resolve integration conflicts, remove duplicate implementations, keep the final code coherent, and summarize verification gaps."
  ].join("\n");
}

function phaseForTeam(team: AgentTeam): "idle" | "running" | "merging" | "completed" | "blocked" {
  if (team.tasks.some(task => task.status === "blocked")) return "blocked";
  if (team.tasks.some(task => task.status === "in_progress")) return team.coordinator?.mergerTaskId ? "merging" : "running";
  if (team.tasks.length > 0 && team.tasks.every(task => task.status === "done" || task.status === "cancelled")) return "completed";
  return "idle";
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
  if (args.preferredAgent !== undefined && !isAgent(args.preferredAgent)) {
    return `invalid preferredAgent: ${String(args.preferredAgent)}`;
  }
  if (args.profile !== undefined) {
    if (!registry.getProfile(args.profile)) return `invalid profile: ${String(args.profile)}`;
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  const verificationError = validateVerificationArgs(args);
  if (verificationError) return verificationError;
  if (args.agentSessionId !== undefined && !isUuid(args.agentSessionId)) return "agentSessionId must be a Claude session UUID";
  return undefined;
}

function validateCreatePlanArgs(args: CreatePlanArgs, registry = new AgentRegistry()): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.request) return "request is required";
  if (args.plannerProfile !== undefined && !registry.getProfile(args.plannerProfile)) {
    return `invalid plannerProfile: ${String(args.plannerProfile)}`;
  }
  if (args.preferredAgent !== undefined && !isAgent(args.preferredAgent)) {
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
  if (args.preferredAgent !== undefined && !isAgent(args.preferredAgent)) {
    return `invalid preferredAgent: ${String(args.preferredAgent)}`;
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  const verificationError = validateVerificationArgs(args);
  if (verificationError) return verificationError;
  if (args.agentSessionId !== undefined && !isUuid(args.agentSessionId)) return "agentSessionId must be a Claude session UUID";
  return undefined;
}

function validateAutoDispatchArgs(args: AutoDispatchArgs): string | undefined {
  if (!args.workspace) return "workspace is required";
  if (!args.request) return "request is required";
  if (args.mode !== undefined && args.mode !== "sync" && args.mode !== "background") {
    return `invalid mode: ${String(args.mode)}`;
  }
  if (args.strategy !== undefined && args.strategy !== "auto" && args.strategy !== "direct" && args.strategy !== "plan") {
    return `invalid strategy: ${String(args.strategy)}`;
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return "timeoutMs must be a positive number";
  }
  const verificationError = validateVerificationArgs(args);
  if (verificationError) return verificationError;
  if (args.agentSessionId !== undefined && !isUuid(args.agentSessionId)) return "agentSessionId must be a Claude session UUID";
  return undefined;
}

function validateVerificationArgs(args: { verifyCommand?: string; maxRepairAttempts?: number }): string | undefined {
  if (args.verifyCommand !== undefined && args.verifyCommand.trim().length === 0) return "verifyCommand must not be empty";
  if (
    args.maxRepairAttempts !== undefined
    && (!Number.isInteger(args.maxRepairAttempts) || args.maxRepairAttempts < 0)
  ) {
    return "maxRepairAttempts must be a non-negative integer";
  }
  return undefined;
}

function resolveAutoDispatchStrategy(args: AutoDispatchArgs): "direct" | "plan" {
  if (args.strategy === "direct" || args.strategy === "plan") return args.strategy;
  const request = args.request.toLowerCase();
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

function isStage(value: unknown): value is Stage {
  return value === "plan" || value === "implement" || value === "review" || value === "analyze";
}

function isAgent(value: unknown): value is AgentName {
  return value === "claude" || value === "codex" || value === "codex-cli" || value === "gemini" || value === "opencode" || value === "myflicker";
}

function isTeamTaskStatus(value: unknown): value is TeamTaskStatus {
  return value === "todo" || value === "in_progress" || value === "done" || value === "blocked" || value === "cancelled";
}

function buildPlannerRequest(request: string): string {
  return [
    "Create an implementation plan for the request below.",
    "Do not modify files. Return a concise markdown plan with goal, constraints, steps, verification, and risks.",
    "The steps section must be a markdown checklist using '- [ ]' items so progress can be tracked later.",
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

function buildSubtaskExecutorRequest(plan: PlanRecord, subtask: string, index: number, total: number, request?: string): string {
  return [
    "Execute only the assigned implementation batch from the implementation plan below. Keep changes scoped to this batch and compatible with sibling batches. Do not commit.",
    request ? `Original request: ${request}` : undefined,
    `Assigned implementation batch ${index}/${total}:`,
    subtask,
    "",
    `Plan file: ${plan.planPath}`,
    "",
    plan.content
  ].filter((line): line is string => line !== undefined).join("\n");
}

function buildWorkflowReviewRequest(plan: PlanRecord, implementTaskIds: string[], request?: string): string {
  return [
    "Review the completed ultrawork implementation tasks against the original request and plan.",
    "Be quick and selective: first inspect verification status, changed files, and the highest-risk integration points.",
    "Do not re-read every child log unless needed. Do not modify files.",
    "Return sections in this order: Findings, Verification, Shared-file risks, Repair recommendation, Residual risk.",
    "Findings must come first and focus on correctness bugs, missing requirements, integration conflicts between child tasks, and missing verification.",
    "If verification failed, is missing, or only passed after repair, call that out explicitly and say whether the result is safe to trust.",
    "Inspect files touched by multiple child tasks first because those are the most likely integration conflict points.",
    request ? `Original request: ${request}` : undefined,
    "",
    `Plan file: ${plan.planPath}`,
    `Implementation task ids: ${implementTaskIds.join(", ")}`,
    "",
    plan.content
  ].filter((line): line is string => line !== undefined).join("\n");
}

function extractPlanSubtasks(content: string, maxImplementationTasks = 6): string[] {
  const tasks = content
    .split(/\r?\n/)
    .map(line => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((task): task is string => Boolean(task));
  if (tasks.length === 0) return ["Execute the implementation plan"];
  const limit = Math.max(1, Math.floor(maxImplementationTasks));
  if (tasks.length <= limit) return tasks;
  const batchSize = Math.ceil(tasks.length / limit);
  const batches: string[] = [];
  for (let start = 0; start < tasks.length; start += batchSize) {
    const batch = tasks.slice(start, start + batchSize);
    batches.push([
      `Plan steps ${start + 1}-${start + batch.length}:`,
      ...batch.map(task => `- ${task}`)
    ].join("\n"));
  }
  return batches;
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

function buildCommandRequest(command: CommandDefinition, request: string | undefined): string | undefined {
  if (!request) return command.requestPrefix;
  return [command.requestPrefix, request].filter(Boolean).join("\n\n");
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

function formatProviderDoctor(result: Awaited<ReturnType<ProviderDoctor["check"]>>): string {
  return [
    `Provider doctor: ${result.ok ? "ready" : "issues found"}`,
    ...result.checks.map(check => [
      `- ${check.provider}: ${check.status}`,
      check.version ? ` (${check.version})` : "",
      check.error ? ` - ${check.error}` : ""
    ].join("")),
    "",
    `Language servers: ${result.languageServerSummary.ready}/${result.languageServerSummary.total} ready`,
    ...result.languageServers.map(check => [
      `- ${check.language}: ${check.status}`,
      check.version ? ` (${check.version})` : "",
      check.error ? ` - ${check.error}` : ""
    ].join(""))
  ].join("\n");
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

function formatAutoDispatchResult(
  strategy: "direct" | "plan",
  reason: string,
  result: Awaited<ReturnType<TaskManager["run"]>>,
  plan?: PlanRecord
): string {
  return [
    "Auto dispatch launched",
    `Strategy: ${strategy}`,
    `Reason: ${reason}`,
    plan ? `Plan: ${plan.planId}` : undefined,
    plan ? `Plan path: ${plan.planPath}` : undefined,
    result.mode === "background" ? `Task: ${result.taskId}` : `Run: ${result.result?.runId}`,
    result.mode === "background" ? `Status: ${result.task?.status ?? "pending"}` : `Status: ${result.result?.ok ? "completed" : "failed"}`
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

function formatCommandCatalog(commands: CommandDefinition[]): string {
  return [
    "Commands",
    ...commands.map(command => `- /${command.name}: ${command.action} - ${command.description}`)
  ].join("\n");
}

function formatTaskPreview(preview: TaskPreview): string {
  return [
    "Task preview",
    `Strategy: ${preview.strategy}`,
    `Risk: ${preview.risk.level} (${preview.risk.score})`,
    `Will modify files: ${preview.willModifyFiles ? "yes" : "no"}`,
    preview.verification.configured ? `Verification: ${preview.verification.command}` : "Verification: not configured",
    "Execution:",
    ...preview.executionPlan.map(step => `- ${step.role}: ${step.stage}${step.profile ? ` / ${step.profile}` : ""}${step.provider ? ` / ${step.provider}` : ""}${step.count ? ` x${step.count}` : ""}`),
    preview.warnings.length > 0 ? "Warnings:" : undefined,
    ...preview.warnings.map(warning => `- ${warning.severity}:${warning.code} - ${warning.message}`),
    `Recommended action: ${preview.recommendedAction}`,
    preview.recommendedSetup ? "Recommended setup:" : undefined,
    preview.recommendedSetup?.tab ? `- tab: ${preview.recommendedSetup.tab}` : undefined,
    preview.recommendedSetup?.command ? `- command: ${preview.recommendedSetup.command}` : undefined,
    preview.recommendedSetup?.mode ? `- mode: ${preview.recommendedSetup.mode}` : undefined,
    preview.recommendedSetup?.strategy ? `- strategy: ${preview.recommendedSetup.strategy}` : undefined,
    preview.recommendedSetup?.preferredAgent !== undefined ? `- preferredAgent: ${preview.recommendedSetup.preferredAgent || "Auto"}` : undefined,
    preview.recommendedSetup?.requiresConfirmation ? "- requires confirmation: true" : undefined,
    ...(preview.recommendedSetup?.notes ?? []).map(note => `- note: ${note}`)
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatTeam(team: AgentTeam): string {
  const taskCounts = team.tasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});
  return [
    `Team: ${team.id}`,
    `Workspace: ${team.workspace}`,
    `Goal: ${team.goal}`,
    `Lead: ${team.lead}`,
    `Members: ${team.members.length}`,
    ...team.members.map(member => `- ${member.id}: ${member.role}${member.profile ? ` / ${member.profile}` : ""}${member.agent ? ` / ${member.agent}` : ""} (${member.status})`),
    `Messages: ${team.messages.length}`,
    `Tasks: ${team.tasks.length}${team.tasks.length > 0 ? ` (${Object.entries(taskCounts).map(([status, count]) => `${status}:${count}`).join(", ")})` : ""}`,
    ...team.tasks.slice(0, 8).map(task => `- ${task.id}: ${task.status} ${task.title}${task.assignee ? ` @${task.assignee}` : ""}${task.linkedTaskId ? ` -> ${task.linkedTaskId}` : ""}`),
    `Updated: ${team.updatedAt}`
  ].join("\n");
}

function formatTeamMessage(message: TeamMessage): string {
  return [
    `Message: ${message.id}`,
    `Team: ${message.teamId}`,
    `From: ${message.from}`,
    `To: ${message.to}`,
    message.taskId ? `Task: ${message.taskId}` : undefined,
    `Body: ${message.body}`,
    `Created: ${message.createdAt}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatTeamTask(task: TeamTask): string {
  return [
    `Team task: ${task.id}`,
    `Team: ${task.teamId}`,
    `Title: ${task.title}`,
    `Status: ${task.status}`,
    task.assignee ? `Assignee: ${task.assignee}` : undefined,
    task.linkedTaskId ? `Linked task: ${task.linkedTaskId}` : undefined,
    task.description ? `Description: ${task.description}` : undefined,
    `Updated: ${task.updatedAt}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

function decorateCommandResult(result: CallToolResult, command: string): CallToolResult {
  return {
    ...result,
    content: result.content.map(item => item.type === "text"
      ? { ...item, text: `Command: /${command}\n${item.text}` }
      : item),
    structuredContent: {
      command,
      ...(result.structuredContent as Record<string, unknown> | undefined)
    }
  };
}

function formatTask(task: {
  id: string;
  status: string;
  runId: string;
  updatedAt: string;
  planId?: string;
  planPath?: string;
  retryOf?: string;
  resumeOf?: string;
  repairOf?: string;
  continuationOf?: string;
  continuationTaskId?: string;
  maxContinuationAttempts?: number;
  continuationAttempt?: number;
  verifyCommand?: string;
  verification?: {
    command: string;
    status: string;
    exitCode?: number | null;
    timedOut?: boolean;
    repairTaskId?: string;
    error?: string;
  };
  resultSummary?: {
    summary?: string;
    quality?: {
      status: string;
      score: number;
      reasons: string[];
    };
    failure?: {
      category: string;
      message: string;
      nextAction: string;
    };
    changedFiles?: string[];
    nextSteps?: string[];
    guardrails?: Array<{ kind: string; severity: string; message: string; file?: string }>;
  };
  guardrails?: Array<{ kind: string; severity: string; message: string; file?: string }>;
  gitCheckpoint?: {
    supported: boolean;
    clean: boolean;
    head?: string;
    error?: string;
  };
  gitDiff?: {
    supported: boolean;
    files: Array<{ path: string; status: string }>;
    error?: string;
  };
  rollback?: {
    status: string;
    error?: string;
  };
  maxRepairAttempts?: number;
  repairAttempt?: number;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  skills?: Array<{ name: string }>;
  error?: string;
}): string {
  return [
    `Task: ${task.id}`,
    `Run: ${task.runId}`,
    `Status: ${task.status}`,
    task.planId ? `Plan: ${task.planId}` : undefined,
    task.planPath ? `Plan path: ${task.planPath}` : undefined,
    task.retryOf ? `Retry of: ${task.retryOf}` : undefined,
    task.resumeOf ? `Resume of: ${task.resumeOf}` : undefined,
    task.repairOf ? `Repair of: ${task.repairOf}` : undefined,
    task.continuationOf ? `Continuation of: ${task.continuationOf}` : undefined,
    task.continuationTaskId ? `Continuation task: ${task.continuationTaskId}` : undefined,
    task.verifyCommand ? `Verify command: ${task.verifyCommand}` : undefined,
    task.verification ? `Verification: ${task.verification.status}` : undefined,
    task.verification?.exitCode !== undefined ? `Verification exit: ${String(task.verification.exitCode)}` : undefined,
    task.verification?.timedOut ? "Verification timed out: true" : undefined,
    task.verification?.repairTaskId ? `Repair task: ${task.verification.repairTaskId}` : undefined,
    task.verification?.error ? `Verification error: ${task.verification.error}` : undefined,
    task.resultSummary?.summary ? `Result summary: ${task.resultSummary.summary}` : undefined,
    task.resultSummary?.quality ? `Quality: ${task.resultSummary.quality.status} (${task.resultSummary.quality.score})` : undefined,
    task.resultSummary?.quality?.reasons?.length ? `Quality reasons: ${task.resultSummary.quality.reasons.join(" | ")}` : undefined,
    task.resultSummary?.failure ? `Failure category: ${task.resultSummary.failure.category}` : undefined,
    task.resultSummary?.failure?.message ? `Failure message: ${task.resultSummary.failure.message}` : undefined,
    task.resultSummary?.failure?.nextAction ? `Suggested action: ${task.resultSummary.failure.nextAction}` : undefined,
    formatGuardrails(task.resultSummary?.guardrails ?? task.guardrails),
    task.resultSummary?.changedFiles && task.resultSummary.changedFiles.length > 0 ? `Changed files: ${task.resultSummary.changedFiles.join(", ")}` : undefined,
    task.resultSummary?.nextSteps && task.resultSummary.nextSteps.length > 0 ? `Next steps: ${task.resultSummary.nextSteps.join(" | ")}` : undefined,
    task.gitCheckpoint ? `Git checkpoint: ${task.gitCheckpoint.supported ? (task.gitCheckpoint.clean ? "clean" : "dirty") : "not available"}` : undefined,
    task.gitCheckpoint?.head ? `Git HEAD: ${task.gitCheckpoint.head}` : undefined,
    task.gitDiff?.files && task.gitDiff.files.length > 0 ? `Git diff files: ${task.gitDiff.files.map(file => `${file.status}:${file.path}`).join(", ")}` : undefined,
    task.rollback ? `Rollback: ${task.rollback.status}` : undefined,
    task.rollback?.error ? `Rollback error: ${task.rollback.error}` : undefined,
    task.maxRepairAttempts !== undefined ? `Max repair attempts: ${task.maxRepairAttempts}` : undefined,
    task.repairAttempt !== undefined ? `Repair attempt: ${task.repairAttempt}` : undefined,
    task.maxContinuationAttempts !== undefined ? `Max continuation attempts: ${task.maxContinuationAttempts}` : undefined,
    task.continuationAttempt !== undefined ? `Continuation attempt: ${task.continuationAttempt}` : undefined,
    task.model ? `Requested model: ${task.model}` : undefined,
    task.effort ? `Effort: ${task.effort}` : undefined,
    task.timeoutMs ? `Timeout: ${task.timeoutMs}ms` : undefined,
    task.skills && task.skills.length > 0 ? `Skills: ${task.skills.map(skill => skill.name).join(", ")}` : undefined,
    `Updated: ${task.updatedAt}`,
    task.error ? `Error: ${task.error}` : undefined
  ].filter(Boolean).join("\n");
}

function formatGuardrails(guardrails?: Array<{ kind: string; severity: string; message: string; file?: string }>): string | undefined {
  if (!guardrails || guardrails.length === 0) return undefined;
  return `Guardrails: ${guardrails.map(issue =>
    `${issue.severity}:${issue.kind}${issue.file ? `(${issue.file})` : ""}`
  ).join(", ")}`;
}

function formatBackgroundOutput(output: Awaited<ReturnType<typeof readBackgroundOutput>>): string {
  const lines = [
    formatTask(output.task),
    "",
    output.deliveryReport ? output.deliveryReport.markdown : undefined,
    output.deliveryReport ? "" : undefined,
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
  if (output.planSummary) {
    lines.push(
      "",
      "Plan summary",
      `Plan: ${output.planSummary.path}`,
      `Progress: ${output.planSummary.completedSteps}/${output.planSummary.totalSteps} (${output.planSummary.progressPercent}%)`,
      ...output.planSummary.steps.map(step => `${step.completed ? "[x]" : "[ ]"} ${step.text}`)
    );
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

function formatCodeSymbols(symbols: CodeSymbol[]): string {
  if (symbols.length === 0) return "No symbols found.";
  return [
    "Symbols",
    ...symbols.map(symbol => `- ${symbol.kind} ${symbol.name} ${symbol.file}:${symbol.line}:${symbol.column}${symbol.exported ? " exported" : ""}`)
  ].join("\n");
}

function formatCodeLocations(title: string, locations: CodeLocation[]): string {
  if (locations.length === 0) return `${title}: none`;
  return [
    title,
    ...locations.map(location => `- ${location.file}:${location.line}:${location.column} ${location.text}`)
  ].join("\n");
}

function formatCodeDiagnostics(diagnostics: Array<CodeLocation & { code?: number | string; category: string; message: string }>): string {
  if (diagnostics.length === 0) return "No diagnostics.";
  return [
    "Diagnostics",
    ...diagnostics.map(diagnostic => `- ${diagnostic.category} ${diagnostic.code === undefined ? "" : diagnostic.code} ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`)
  ].join("\n");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
