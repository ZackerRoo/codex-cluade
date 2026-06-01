import type { AgentName, AgentProfileName, Stage, TaskMode } from "../types.js";
import type { AutoDispatchStrategy } from "../mcp/tools.js";
import type { BridgeConfig } from "../config/BridgeConfig.js";

export type CommandAction = "auto_dispatch" | "delegate_task" | "create_plan" | "execute_plan" | "ultrawork";

export interface CommandDefinition {
  name: string;
  description: string;
  action: CommandAction;
  requestPrefix?: string;
  mode?: TaskMode;
  strategy?: AutoDispatchStrategy;
  stage?: Stage;
  stages?: Stage[];
  profile?: AgentProfileName;
  plannerProfile?: AgentProfileName;
  executorProfile?: AgentProfileName;
  preferredAgent?: AgentName;
  loadSkills?: string[];
}

const builtins: Record<string, CommandDefinition> = {
  "start-work": {
    name: "start-work",
    description: "Start implementation from a natural-language request using auto dispatch.",
    action: "auto_dispatch",
    mode: "background",
    strategy: "auto"
  },
  "plan-work": {
    name: "plan-work",
    description: "Create a saved implementation plan without executing it.",
    action: "create_plan",
    plannerProfile: "prometheus"
  },
  ultrawork: {
    name: "ultrawork",
    description: "Plan first, then launch implementation with multi-provider fallback.",
    action: "ultrawork",
    mode: "background",
    plannerProfile: "prometheus",
    executorProfile: "multi-coder"
  },
  "review-work": {
    name: "review-work",
    description: "Run an independent review stage for the current workspace.",
    action: "delegate_task",
    mode: "background",
    stage: "review",
    profile: "reviewer"
  },
  "multi-work": {
    name: "multi-work",
    description: "Start implementation with multi-provider fallback.",
    action: "delegate_task",
    mode: "background",
    stage: "implement",
    profile: "multi-coder"
  },
  explore: {
    name: "explore",
    description: "Explore the codebase without editing files.",
    action: "delegate_task",
    mode: "background",
    stage: "analyze",
    profile: "explore"
  },
  "frontend-work": {
    name: "frontend-work",
    description: "Start frontend implementation with the frontend specialist profile.",
    action: "delegate_task",
    mode: "background",
    stage: "implement",
    profile: "frontend"
  },
  "sisyphus-work": {
    name: "sisyphus-work",
    description: "Start scoped implementation with the Sisyphus execution profile.",
    action: "delegate_task",
    mode: "background",
    stage: "implement",
    profile: "sisyphus"
  },
  "momus-review": {
    name: "momus-review",
    description: "Run strict Momus review.",
    action: "delegate_task",
    mode: "background",
    stage: "review",
    profile: "momus"
  }
};

export class CommandRegistry {
  private readonly commands: Record<string, CommandDefinition>;

  constructor(config: BridgeConfig = {}) {
    this.commands = mergeDefinitions(builtins, config.commands);
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands[normalizeCommandName(name)];
  }

  list(): CommandDefinition[] {
    return Object.values(this.commands);
  }
}

export function parseCommandText(command: string): { name: string; request?: string } {
  const trimmed = command.trim();
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const [name = "", ...rest] = withoutSlash.split(/\s+/);
  const request = rest.join(" ").trim();
  return {
    name: normalizeCommandName(name),
    request: request.length > 0 ? request : undefined
  };
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\//, "").toLowerCase();
}

function mergeDefinitions(
  defaults: Record<string, CommandDefinition>,
  overrides: Record<string, Partial<CommandDefinition>> | undefined
): Record<string, CommandDefinition> {
  if (!overrides) return { ...defaults };
  const merged: Record<string, CommandDefinition> = { ...defaults };
  for (const [name, override] of Object.entries(overrides)) {
    const normalized = normalizeCommandName(name);
    merged[normalized] = {
      ...(merged[normalized] ?? {
        name: normalized,
        description: "",
        action: "auto_dispatch" as const
      }),
      ...override,
      name: normalized
    };
  }
  return merged;
}
