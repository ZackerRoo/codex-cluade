export type Stage = "plan" | "implement" | "review" | "analyze";
export type AgentName = "claude" | "codex";
export type StageStatus = "completed" | "failed" | "requires_codex" | "skipped";

export interface StageInput {
  stage: Stage;
  agent: AgentName;
  workspace: string;
  request: string;
  runId?: string;
  previousOutputs?: Record<string, string>;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface StageResult {
  ok: boolean;
  runId: string;
  stage: Stage;
  agent: AgentName;
  status: StageStatus;
  outputPath?: string;
  logPath?: string;
  changedFiles: string[];
  requiresCodex: boolean;
  summary: string;
  error?: string;
}
