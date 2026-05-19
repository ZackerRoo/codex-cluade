import { AgentRegistry } from "../agents/AgentRegistry.js";
import type { AgentRouteCandidate } from "../agents/AgentRegistry.js";
import type { AgentName, AgentProfileName, Effort, PermissionPolicy, Stage, TaskCategory } from "../types.js";

export type RoutingConfig = Partial<Record<Stage, AgentName>>;
export interface RoutingContext {
  category?: TaskCategory;
  profile?: AgentProfileName;
  preferredAgent?: AgentName;
}
export interface AgentRoute {
  agent: AgentName;
  category?: TaskCategory;
  profile?: AgentProfileName;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  permission?: PermissionPolicy;
  fallbacks?: AgentRouteCandidate[];
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
    return this.resolveRoute(stage, config, context).agent;
  }

  resolveRoute(stage: Stage, config: RoutingConfig, context: RoutingContext = {}): AgentRoute {
    if (context.preferredAgent) return { agent: context.preferredAgent };
    if (context.profile) {
      const profile = this.registry.getProfile(context.profile);
      if (profile) {
        return {
          agent: profile.agent,
          category: profile.category,
          profile: profile.name,
          model: profile.model,
          effort: profile.effort,
          timeoutMs: profile.timeoutMs,
          permission: profile.permission,
          fallbacks: profile.fallbacks
        };
      }
    }
    if (context.category) {
      const category = this.registry.getCategory(context.category);
      if (category) {
        return {
          agent: category.agent,
          category: category.name,
          model: category.model,
          effort: category.effort,
          permission: category.permission,
          fallbacks: category.fallbacks
        };
      }
    }
    return { agent: config[stage] ?? defaults[stage] };
  }
}
