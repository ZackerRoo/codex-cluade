import { AgentRegistry } from "../agents/AgentRegistry.js";
import type { AgentName, Stage, TaskCategory } from "../types.js";

export type RoutingConfig = Partial<Record<Stage, AgentName>>;
export interface RoutingContext {
  category?: TaskCategory;
  preferredAgent?: AgentName;
}

const defaults: Record<Stage, AgentName> = {
  plan: "codex",
  implement: "claude",
  review: "codex",
  analyze: "codex"
};

export class AgentRouter {
  constructor(private readonly registry = new AgentRegistry()) {}

  resolve(stage: Stage, config: RoutingConfig, context: RoutingContext = {}): AgentName {
    if (context.preferredAgent) return context.preferredAgent;
    if (context.category) {
      const category = this.registry.getCategory(context.category);
      if (category) return category.agent;
    }
    return config[stage] ?? defaults[stage];
  }
}
