import { readFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeCodeAgentOptions } from "../agents/ClaudeCodeAgent.js";
import { AgentRegistry } from "../agents/AgentRegistry.js";
import { ClaudeCodeAgent } from "../agents/ClaudeCodeAgent.js";
import { CodexCliAgent, GeminiCliAgent, OpenCodeAgent } from "../agents/CliCodeAgent.js";
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

export interface TaskToolSet {
  providerDoctorTool(): Promise<CallToolResult>;
  commandCatalogTool(): Promise<CallToolResult>;
  runCommandTool(args: RunCommandArgs): Promise<CallToolResult>;
  autoDispatchTool(args: AutoDispatchArgs): Promise<CallToolResult>;
  delegateTaskTool(args: DelegateTaskArgs): Promise<CallToolResult>;
  createPlanTool(args: CreatePlanArgs): Promise<CallToolResult>;
  executePlanTool(args: ExecutePlanArgs): Promise<CallToolResult>;
  taskStatusTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskCancelTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskRetryTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskResumeTool(args: TaskLookupArgs): Promise<CallToolResult>;
  backgroundOutputTool(args: TaskLookupArgs): Promise<CallToolResult>;
  taskListTool(): Promise<CallToolResult>;
  agentCatalogTool(): Promise<CallToolResult>;
  codeSymbolsTool(args: CodeSymbolsArgs): Promise<CallToolResult>;
  codeDefinitionTool(args: CodePositionArgs): Promise<CallToolResult>;
  codeReferencesTool(args: CodePositionArgs): Promise<CallToolResult>;
  codeDiagnosticsTool(args: CodeDiagnosticsArgs): Promise<CallToolResult>;
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
} = {}): TaskToolSet {
  const config = options.config ?? loadBridgeConfig();
  const registry = new AgentRegistry(config);
  const commandRegistry = new CommandRegistry(config);
  const manager = options.taskManager ?? createTaskManager({ config, registry, claude: options.claude, taskStore: options.taskStore });

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
      codex: new CodexAgent()
    }
  });
  return new TaskManager(coordinator, options.taskStore, { concurrency: config.concurrency });
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
  const subtasks = extractPlanSubtasks(plan.content);
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
    verifyCommand: args.verifyCommand,
    maxRepairAttempts: args.maxRepairAttempts
  });
  return {
    content: [{
      type: "text",
      text: [
        "Ultrawork launched",
        `planId: ${planId}`,
        `planPath: ${planPath}`,
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
      reviewTaskId
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
  return value === "claude" || value === "codex" || value === "codex-cli" || value === "gemini" || value === "opencode";
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
    "Execute only the assigned subtask from the implementation plan below. Keep changes scoped to this subtask and compatible with sibling subtasks. Do not commit.",
    request ? `Original request: ${request}` : undefined,
    `Assigned subtask ${index}/${total}: ${subtask}`,
    "",
    `Plan file: ${plan.planPath}`,
    "",
    plan.content
  ].filter((line): line is string => line !== undefined).join("\n");
}

function buildWorkflowReviewRequest(plan: PlanRecord, implementTaskIds: string[], request?: string): string {
  return [
    "Review the completed ultrawork implementation tasks against the original request and plan.",
    "Return findings first. Focus on correctness bugs, missing requirements, integration conflicts between child tasks, and missing verification.",
    request ? `Original request: ${request}` : undefined,
    "",
    `Plan file: ${plan.planPath}`,
    `Implementation task ids: ${implementTaskIds.join(", ")}`,
    "",
    plan.content
  ].filter((line): line is string => line !== undefined).join("\n");
}

function extractPlanSubtasks(content: string): string[] {
  const tasks = content
    .split(/\r?\n/)
    .map(line => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((task): task is string => Boolean(task));
  return tasks.length > 0 ? tasks : ["Execute the implementation plan"];
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
  verifyCommand?: string;
  verification?: {
    command: string;
    status: string;
    exitCode?: number | null;
    timedOut?: boolean;
    repairTaskId?: string;
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
    task.verifyCommand ? `Verify command: ${task.verifyCommand}` : undefined,
    task.verification ? `Verification: ${task.verification.status}` : undefined,
    task.verification?.exitCode !== undefined ? `Verification exit: ${String(task.verification.exitCode)}` : undefined,
    task.verification?.timedOut ? "Verification timed out: true" : undefined,
    task.verification?.repairTaskId ? `Repair task: ${task.verification.repairTaskId}` : undefined,
    task.verification?.error ? `Verification error: ${task.verification.error}` : undefined,
    task.maxRepairAttempts !== undefined ? `Max repair attempts: ${task.maxRepairAttempts}` : undefined,
    task.repairAttempt !== undefined ? `Repair attempt: ${task.repairAttempt}` : undefined,
    task.model ? `Requested model: ${task.model}` : undefined,
    task.effort ? `Effort: ${task.effort}` : undefined,
    task.timeoutMs ? `Timeout: ${task.timeoutMs}ms` : undefined,
    task.skills && task.skills.length > 0 ? `Skills: ${task.skills.map(skill => skill.name).join(", ")}` : undefined,
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
