import type { AgentName, AgentProfileName, Effort, Stage, TaskCategory } from "../types.js";

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
  fallbacks?: AgentRouteCandidate[];
}

export interface AgentRouteCandidate {
  agent: AgentName;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
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
  fallbacks?: AgentRouteCandidate[];
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
    fallbacks: [{ agent: "codex" }]
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
    fallbacks: [{ agent: "codex" }]
  }
};

const profiles: Record<string, AgentProfile> = {
  planner: {
    name: "planner",
    description: "Read-only planning and decomposition handled by Codex.",
    category: "planning",
    agent: "codex",
    stages: ["plan"]
  },
  coder: {
    name: "coder",
    description: "Implementation work handled by local Claude Code.",
    category: "coding",
    agent: "claude",
    stages: ["implement"],
    fallbacks: [{ agent: "codex" }]
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
    fallbacks: [{ agent: "codex" }]
  }
};

export class AgentRegistry {
  getAgent(name: AgentName): AgentDefinition | undefined {
    return agents[name];
  }

  getCategory(name: TaskCategory): CategoryDefinition | undefined {
    return categories[name];
  }

  getProfile(name: AgentProfileName): AgentProfile | undefined {
    return profiles[name];
  }

  listAgents(): AgentDefinition[] {
    return Object.values(agents);
  }

  listCategories(): CategoryDefinition[] {
    return Object.values(categories);
  }

  listProfiles(): AgentProfile[] {
    return Object.values(profiles);
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
