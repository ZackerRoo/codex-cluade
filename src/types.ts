export type Stage = "plan" | "implement" | "review" | "analyze";
export type AgentName = "claude" | "codex";
export type StageStatus = "completed" | "failed" | "requires_codex" | "skipped";
export type TaskMode = "sync" | "background";
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TaskCategory = "planning" | "coding" | "review" | "analysis" | "fast" | "heavy" | string;
export type AgentProfileName = "planner" | "coder" | "reviewer" | "analyst" | "quick" | "heavy-coder" | string;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StageInput {
  stage: Stage;
  agent: AgentName;
  workspace: string;
  request: string;
  runId?: string;
  agentSessionId?: string;
  previousOutputs?: Record<string, string>;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StageResult {
  ok: boolean;
  runId: string;
  stage: Stage;
  agent: AgentName;
  status: StageStatus;
  outputPath?: string;
  logPath?: string;
  agentSessionId?: string;
  agentTranscriptPath?: string;
  resumeCommand?: string;
  changedFiles: string[];
  requiresCodex: boolean;
  summary: string;
  error?: string;
}

export interface DelegatedTask {
  id: string;
  mode: TaskMode;
  status: TaskStatus;
  workspace: string;
  request: string;
  stages: Stage[];
  category?: TaskCategory;
  profile?: AgentProfileName;
  preferredAgent?: AgentName;
  runId: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}
