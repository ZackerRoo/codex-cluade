import type { AgentProvider } from "../agents/AgentProvider.js";
import type { AgentName, StageInput, StageResult } from "../types.js";

export class StageRunner {
  constructor(private readonly providers: Partial<Record<AgentName, AgentProvider>>) {}

  hasProvider(agent: AgentName): boolean {
    return this.providers[agent] !== undefined;
  }

  async run(input: StageInput): Promise<StageResult> {
    if (input.signal?.aborted) {
      return {
        ok: false,
        runId: input.runId ?? "manual",
        stage: input.stage,
        agent: input.agent,
        status: "failed",
        changedFiles: [],
        requiresCodex: false,
        summary: `${input.stage} cancelled`,
        error: "Task cancelled"
      };
    }
    const provider = this.providers[input.agent];
    if (!provider) {
      return {
        ok: false,
        runId: input.runId ?? "manual",
        stage: input.stage,
        agent: input.agent,
        status: "failed",
        changedFiles: [],
        requiresCodex: false,
        summary: `No provider registered for ${input.agent}`,
        error: `Unknown agent: ${input.agent}`
      };
    }
    return provider.run(input);
  }
}
