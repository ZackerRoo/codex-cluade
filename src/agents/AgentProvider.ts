import type { AgentName, StageInput, StageResult } from "../types.js";

export interface AgentProvider {
  readonly name: AgentName;
  run(input: StageInput): Promise<StageResult>;
}
