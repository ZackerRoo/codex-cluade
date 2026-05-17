import type { AgentName, Stage, TaskCategory } from "../types.js";

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
    agent: "claude"
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
    agent: "claude"
  }
};

export class AgentRegistry {
  getAgent(name: AgentName): AgentDefinition | undefined {
    return agents[name];
  }

  getCategory(name: TaskCategory): CategoryDefinition | undefined {
    return categories[name];
  }

  listAgents(): AgentDefinition[] {
    return Object.values(agents);
  }

  listCategories(): CategoryDefinition[] {
    return Object.values(categories);
  }
}
