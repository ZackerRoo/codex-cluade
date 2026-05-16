import type { AgentProvider } from "./AgentProvider.js";
import type { StageInput, StageResult } from "../types.js";

export class CodexAgent implements AgentProvider {
  readonly name = "codex" as const;

  async run(input: StageInput): Promise<StageResult> {
    return {
      ok: true,
      runId: input.runId ?? "manual",
      stage: input.stage,
      agent: "codex",
      status: "requires_codex",
      changedFiles: [],
      requiresCodex: true,
      summary: "This stage should be handled by the current Codex Desktop session."
    };
  }
}
