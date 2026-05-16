import { readFile } from "node:fs/promises";
import type { AgentProvider } from "../agents/AgentProvider.js";
import type { AgentName, Stage, StageResult } from "../types.js";
import { AgentRouter, type RoutingConfig } from "./AgentRouter.js";
import { StageRunner } from "./StageRunner.js";

export interface CoordinatorInput {
  workspace: string;
  request: string;
  stages: Stage[];
  routing: RoutingConfig;
  runId?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface CoordinatorResult {
  ok: boolean;
  runId: string;
  results: StageResult[];
  summary: string;
}

export class AgentCoordinator {
  private readonly router = new AgentRouter();
  private readonly runner: StageRunner;

  constructor(options: { providers: Record<AgentName, AgentProvider> }) {
    this.runner = new StageRunner(options.providers);
  }

  async run(input: CoordinatorInput): Promise<CoordinatorResult> {
    const runId = input.runId ?? createRunId();
    const previousOutputs: Record<string, string> = {};
    const results: StageResult[] = [];

    for (const stage of input.stages) {
      const agent = this.router.resolve(stage, input.routing);
      const result = await this.runner.run({
        stage,
        agent,
        workspace: input.workspace,
        request: input.request,
        runId,
        previousOutputs,
        model: input.model,
        effort: input.effort,
        timeoutMs: input.timeoutMs
      });
      results.push(result);
      previousOutputs[stage] = await loadResultOutput(result);
      if (!result.ok) break;
    }

    return {
      ok: results.every(result => result.ok),
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
