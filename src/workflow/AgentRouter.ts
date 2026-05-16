import type { AgentName, Stage } from "../types.js";

export type RoutingConfig = Partial<Record<Stage, AgentName>>;

const defaults: Record<Stage, AgentName> = {
  plan: "codex",
  implement: "claude",
  review: "codex",
  analyze: "codex"
};

export class AgentRouter {
  resolve(stage: Stage, config: RoutingConfig): AgentName {
    return config[stage] ?? defaults[stage];
  }
}
