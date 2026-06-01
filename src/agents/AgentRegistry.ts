import type { AgentName, AgentProfileName, Effort, PermissionPolicy, Stage, TaskCategory } from "../types.js";
import type { BridgeConfig } from "../config/BridgeConfig.js";

export interface AgentDefinition {
  name: AgentName;
  description: string;
  defaultStages: Stage[];
  categories: TaskCategory[];
}

export interface CategoryDefinition {
  name: TaskCategory;
  description: string;
  agent: AgentName;
  model?: string;
  effort?: Effort;
  permission?: PermissionPolicy;
  fallbacks?: AgentRouteCandidate[];
}

export interface AgentRouteCandidate {
  agent: AgentName;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  permission?: PermissionPolicy;
}

export interface AgentProfile {
  name: AgentProfileName;
  description: string;
  category: TaskCategory;
  agent: AgentName;
  stages?: Stage[];
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  permission?: PermissionPolicy;
  fallbacks?: AgentRouteCandidate[];
  rolePrompt?: string;
}

export interface TaskClassificationInput {
  request: string;
  stages: Stage[];
}

const agents: Record<AgentName, AgentDefinition> = {
  claude: {
    name: "claude",
    description: "Local Claude Code CLI for implementation-heavy delegated work.",
    defaultStages: ["implement"],
    categories: ["coding", "heavy"]
  },
  codex: {
    name: "codex",
    description: "Current Codex Desktop session for review, analysis, and handoff work.",
    defaultStages: ["plan", "review", "analyze"],
    categories: ["planning", "review", "analysis", "fast"]
  },
  "codex-cli": {
    name: "codex-cli",
    description: "Local Codex CLI provider for non-interactive delegated work.",
    defaultStages: ["plan", "implement", "review", "analyze"],
    categories: ["coding", "heavy", "review", "analysis"]
  },
  gemini: {
    name: "gemini",
    description: "Local Gemini CLI provider for headless delegated work.",
    defaultStages: ["plan", "implement", "review", "analyze"],
    categories: ["coding", "heavy", "planning", "analysis"]
  },
  opencode: {
    name: "opencode",
    description: "Optional OpenCode CLI provider when installed and configured.",
    defaultStages: ["plan", "implement", "review", "analyze"],
    categories: ["coding", "heavy", "planning", "analysis"]
  }
};

const categories: Record<string, CategoryDefinition> = {
  planning: {
    name: "planning",
    description: "Planning and design work that should avoid direct edits.",
    agent: "codex"
  },
  coding: {
    name: "coding",
    description: "Implementation work that may edit files and run commands.",
    agent: "claude",
    fallbacks: [{ agent: "codex-cli" }, { agent: "gemini" }, { agent: "codex" }]
  },
  review: {
    name: "review",
    description: "Independent review and verification.",
    agent: "codex"
  },
  analysis: {
    name: "analysis",
    description: "Read-only codebase or behavior analysis.",
    agent: "codex"
  },
  fast: {
    name: "fast",
    description: "Low-latency local Codex handoff.",
    agent: "codex"
  },
  heavy: {
    name: "heavy",
    description: "Heavier delegated work for Claude Code.",
    agent: "claude",
    effort: "high",
    fallbacks: [{ agent: "codex-cli", effort: "high" }, { agent: "gemini" }, { agent: "codex" }]
  }
};

const profiles: Record<string, AgentProfile> = {
  planner: {
    name: "planner",
    description: "Read-only planning and decomposition handled by Codex.",
    category: "planning",
    agent: "codex",
    stages: ["plan"],
    rolePrompt: "You are a planner. Decompose the request into scoped steps, risks, and verification. Do not modify files."
  },
  coder: {
    name: "coder",
    description: "Implementation work handled by local Claude Code.",
    category: "coding",
    agent: "claude",
    stages: ["implement"],
    fallbacks: [{ agent: "codex-cli" }, { agent: "gemini" }, { agent: "codex" }]
  },
  "codex-coder": {
    name: "codex-coder",
    description: "Implementation work handled by local Codex CLI.",
    category: "coding",
    agent: "codex-cli",
    stages: ["implement"]
  },
  "gemini-coder": {
    name: "gemini-coder",
    description: "Implementation work handled by local Gemini CLI.",
    category: "coding",
    agent: "gemini",
    stages: ["implement"]
  },
  "multi-coder": {
    name: "multi-coder",
    description: "Implementation with provider fallback: Claude, Codex CLI, Gemini, then Codex handoff.",
    category: "coding",
    agent: "claude",
    stages: ["implement"],
    fallbacks: [{ agent: "codex-cli" }, { agent: "gemini" }, { agent: "codex" }]
  },
  explore: {
    name: "explore",
    description: "Read-only codebase exploration agent. Maps files, patterns, dependencies, and risks.",
    category: "analysis",
    agent: "codex",
    stages: ["analyze"],
    rolePrompt: "You are Explore. Inspect the workspace without editing files. Map relevant files, APIs, patterns, dependencies, and unknowns. Return concise findings and recommended next steps."
  },
  prometheus: {
    name: "prometheus",
    description: "Strategic planning agent for implementation plans with checklist steps.",
    category: "planning",
    agent: "claude",
    stages: ["plan"],
    permission: { mode: "default", disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit"] },
    rolePrompt: "You are Prometheus. Create a high-quality implementation plan. Clarify scope, identify guardrails, include exact files or areas to inspect, and produce markdown checklist steps. Do not edit source files."
  },
  sisyphus: {
    name: "sisyphus",
    description: "Execution agent for scoped implementation work with verification.",
    category: "coding",
    agent: "claude",
    stages: ["implement"],
    effort: "high",
    fallbacks: [{ agent: "codex-cli", effort: "high" }, { agent: "gemini" }, { agent: "codex" }],
    rolePrompt: "You are Sisyphus. Execute the implementation task completely. Keep changes scoped, update only necessary files, run relevant verification, and report changed files and test results. Do not commit."
  },
  momus: {
    name: "momus",
    description: "Strict review agent for plans or code changes.",
    category: "review",
    agent: "claude",
    stages: ["review"],
    permission: { mode: "default", disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit"] },
    fallbacks: [{ agent: "codex-cli", effort: "medium" }, { agent: "gemini" }, { agent: "codex" }],
    rolePrompt: "You are Momus. Be a strict reviewer. Prioritize correctness bugs, regressions, missing tests, unclear assumptions, and incomplete verification. Return findings first with concrete file or plan references."
  },
  frontend: {
    name: "frontend",
    description: "Frontend implementation agent focused on usable UI, responsive layout, and browser verification.",
    category: "coding",
    agent: "claude",
    stages: ["implement"],
    effort: "high",
    fallbacks: [{ agent: "codex-cli", effort: "high" }, { agent: "gemini" }, { agent: "codex" }],
    rolePrompt: "You are Frontend. Build the actual usable interface first, keep layout responsive, avoid text overlap, and verify in a browser when applicable. Keep changes scoped and do not commit."
  },
  reviewer: {
    name: "reviewer",
    description: "Independent review handled by Codex.",
    category: "review",
    agent: "codex",
    stages: ["review"]
  },
  analyst: {
    name: "analyst",
    description: "Read-only investigation handled by Codex.",
    category: "analysis",
    agent: "codex",
    stages: ["analyze"]
  },
  quick: {
    name: "quick",
    description: "Low-latency local handoff for small read-only work.",
    category: "fast",
    agent: "codex",
    effort: "low",
    timeoutMs: 60_000
  },
  "heavy-coder": {
    name: "heavy-coder",
    description: "Longer implementation tasks handled by Claude Code with higher effort.",
    category: "heavy",
    agent: "claude",
    stages: ["implement"],
    effort: "high",
    timeoutMs: 900_000,
    fallbacks: [{ agent: "codex-cli", effort: "high" }, { agent: "gemini" }, { agent: "codex" }]
  }
};

export class AgentRegistry {
  private readonly agents = agents;
  private readonly categories: Record<string, CategoryDefinition>;
  private readonly profiles: Record<string, AgentProfile>;

  constructor(config: BridgeConfig = {}) {
    this.categories = mergeDefinitions(categories, config.categories);
    this.profiles = mergeDefinitions(profiles, config.profiles);
  }

  getAgent(name: AgentName): AgentDefinition | undefined {
    return this.agents[name];
  }

  getCategory(name: TaskCategory): CategoryDefinition | undefined {
    return this.categories[name];
  }

  getProfile(name: AgentProfileName): AgentProfile | undefined {
    return this.profiles[name];
  }

  listAgents(): AgentDefinition[] {
    return Object.values(this.agents);
  }

  listCategories(): CategoryDefinition[] {
    return Object.values(this.categories);
  }

  listProfiles(): AgentProfile[] {
    return Object.values(this.profiles);
  }

  classifyTask(input: TaskClassificationInput): TaskCategory {
    const text = input.request.toLowerCase();
    if (input.stages.includes("implement")) return input.stages.length > 1 ? "heavy" : "coding";
    if (input.stages.includes("review") || /\b(review|audit|check|cr|pr)\b/.test(text)) return "review";
    if (input.stages.includes("analyze") || /\b(analy[sz]e|inspect|investigate|understand|explain)\b/.test(text)) {
      return "analysis";
    }
    if (/\b(implement|code|fix|build|refactor|change|edit)\b/.test(text)) return "coding";
    if (/\b(plan|design|方案|计划|规划)\b/.test(text)) return "planning";
    return text.length < 240 ? "fast" : "planning";
  }
}

function mergeDefinitions<T extends { name: string }>(
  builtins: Record<string, T>,
  overrides: Record<string, Partial<T>> | undefined
): Record<string, T> {
  if (!overrides) return { ...builtins };
  const merged: Record<string, T> = { ...builtins };
  for (const [name, override] of Object.entries(overrides)) {
    merged[name] = {
      ...(merged[name] ?? { name }),
      ...override,
      name
    } as T;
  }
  return merged;
}
