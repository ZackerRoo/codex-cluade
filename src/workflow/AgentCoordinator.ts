import { readFile } from "node:fs/promises";
import { AgentRegistry } from "../agents/AgentRegistry.js";
import type { AgentProvider } from "../agents/AgentProvider.js";
import { buildWorkspaceContext } from "../context/WorkspaceContext.js";
import type { AgentName, AgentProfileName, Effort, InjectedSkill, Stage, StageResult, TaskCategory } from "../types.js";
import { AgentRouter, type RoutingConfig } from "./AgentRouter.js";
import { StageRunner } from "./StageRunner.js";

export interface CoordinatorInput {
  workspace: string;
  request: string;
  stages: Stage[];
  routing: RoutingConfig;
  category?: TaskCategory;
  profile?: AgentProfileName;
  autoCategory?: boolean;
  preferredAgent?: AgentName;
  runId?: string;
  agentSessionId?: string;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  skills?: InjectedSkill[];
  signal?: AbortSignal;
}

export interface CoordinatorResult {
  ok: boolean;
  runId: string;
  results: StageResult[];
  summary: string;
}

export class AgentCoordinator {
  private readonly registry: AgentRegistry;
  private readonly router: AgentRouter;
  private readonly runner: StageRunner;

  constructor(options: { providers: Partial<Record<AgentName, AgentProvider>>; registry?: AgentRegistry }) {
    this.registry = options.registry ?? new AgentRegistry();
    this.router = new AgentRouter(this.registry);
    this.runner = new StageRunner(options.providers);
  }

  async run(input: CoordinatorInput): Promise<CoordinatorResult> {
    const runId = input.runId ?? createRunId();
    const profile = input.profile ? this.registry.getProfile(input.profile) : undefined;
    const stages = input.stages.length > 0 ? input.stages : profile?.stages ?? ["plan"];
    const category = input.category ?? profile?.category ?? (input.autoCategory ? this.registry.classifyTask({
      request: input.request,
      stages
    }) : undefined);
    const previousOutputs: Record<string, string> = {};
    const results: StageResult[] = [];
    const stageOutcomes: StageResult[] = [];
    const workspaceContext = await buildWorkspaceContext({ workspace: input.workspace });

    for (const stage of stages) {
      if (input.signal?.aborted) {
        results.push({
          ok: false,
          runId,
          stage,
          agent: "codex",
          status: "failed",
          changedFiles: [],
          requiresCodex: false,
          summary: `${stage} cancelled`,
          error: "Task cancelled"
        });
        stageOutcomes.push(results[results.length - 1]);
        break;
      }
      const route = this.router.resolveRoute(stage, input.routing, {
        category,
        profile: input.profile,
        preferredAgent: input.preferredAgent
      });
      let result = await this.runner.run({
        stage,
        agent: route.agent,
        workspace: input.workspace,
        request: input.request,
        rolePrompt: route.rolePrompt ?? profile?.rolePrompt,
        workspaceContext,
        runId,
        agentSessionId: input.agentSessionId,
        previousOutputs,
        model: input.model ?? route.model ?? profile?.model,
        effort: input.effort ?? route.effort ?? profile?.effort,
        timeoutMs: input.timeoutMs ?? route.timeoutMs ?? profile?.timeoutMs,
        permission: route.permission ?? profile?.permission,
        skills: input.skills,
        signal: input.signal
      });
      results.push(result);

      if (!result.ok && route.fallbacks && route.fallbacks.length > 0 && !input.signal?.aborted) {
        for (const fallback of route.fallbacks) {
          if (!this.runner.hasProvider(fallback.agent)) continue;
          result = await this.runner.run({
            stage,
            agent: fallback.agent,
            workspace: input.workspace,
            request: input.request,
            rolePrompt: profile?.rolePrompt,
            workspaceContext,
            runId,
            agentSessionId: input.agentSessionId,
            previousOutputs,
            model: input.model ?? fallback.model,
            effort: input.effort ?? fallback.effort,
            timeoutMs: input.timeoutMs ?? fallback.timeoutMs,
            permission: fallback.permission,
            skills: input.skills,
            signal: input.signal
          });
          results.push(result);
          if (result.ok) break;
        }
      }
      stageOutcomes.push(result);
      previousOutputs[stage] = await loadResultOutput(result);
      if (!result.ok) break;
    }

    return {
      ok: stageOutcomes.every(result => result.ok),
      runId,
      results,
      summary: results.map(result => `${result.stage}: ${result.summary}`).join("\n")
    };
  }
}

function createRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${date}-${suffix}`;
}

async function loadResultOutput(result: StageResult): Promise<string> {
  if (!result.outputPath) return result.summary;
  try {
    return await readFile(result.outputPath, "utf8");
  } catch {
    return result.summary;
  }
}
