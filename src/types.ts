export type Stage = "plan" | "implement" | "review" | "analyze";
export type AgentName = "claude" | "codex" | "codex-cli" | "gemini" | "opencode";
export type StageStatus = "completed" | "failed" | "requires_codex" | "skipped";
export type TaskMode = "sync" | "background";
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type TaskKind = "task" | "workflow";
export type WorkflowPhase = "executing" | "reviewing" | "completed" | "failed" | "cancelled" | "interrupted";
export type TaskCategory = "planning" | "coding" | "review" | "analysis" | "fast" | "heavy" | string;
export type AgentProfileName = "planner" | "coder" | "reviewer" | "analyst" | "quick" | "heavy-coder" | string;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";

export interface PermissionPolicy {
  mode?: ClaudePermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface InjectedSkill {
  name: string;
  content: string;
}

export interface StageInput {
  stage: Stage;
  agent: AgentName;
  workspace: string;
  request: string;
  rolePrompt?: string;
  workspaceContext?: string;
  runId?: string;
  agentSessionId?: string;
  previousOutputs?: Record<string, string>;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  permission?: PermissionPolicy;
  skills?: InjectedSkill[];
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

export interface VerificationResult {
  command: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  repairTaskId?: string;
}

export interface WorkflowStepState {
  id: string;
  text: string;
  kind: "task" | "review";
  taskId: string;
  status: TaskStatus | "missing";
  line?: number;
}

export interface WorkflowLearning {
  taskId: string;
  summary: string;
  changedFiles: string[];
}

export interface WorkflowNextAction {
  kind: "wait" | "retry_failed_parts" | "complete" | "cancelled" | "resume";
  reason: string;
  taskIds?: string[];
}

export interface WorkflowState {
  workflowId: string;
  request: string;
  phase: WorkflowPhase;
  planId?: string;
  planPath?: string;
  statePath: string;
  childTaskIds: string[];
  reviewTaskId?: string;
  steps: WorkflowStepState[];
  learnings: WorkflowLearning[];
  nextAction: WorkflowNextAction;
  createdAt: string;
  updatedAt: string;
}

export interface DelegatedTask {
  id: string;
  kind?: TaskKind;
  mode: TaskMode;
  status: TaskStatus;
  workspace: string;
  request: string;
  stages: Stage[];
  category?: TaskCategory;
  profile?: AgentProfileName;
  preferredAgent?: AgentName;
  agentSessionId?: string;
  planId?: string;
  planPath?: string;
  parentTaskId?: string;
  childTaskIds?: string[];
  dependsOnTaskIds?: string[];
  reviewTaskId?: string;
  workflow?: {
    kind: "ultrawork";
    summary?: {
      total: number;
      completed: number;
      failed: number;
      running: number;
      pending: number;
    };
    statePath?: string;
    state?: WorkflowState;
  };
  retryOf?: string;
  resumeOf?: string;
  repairOf?: string;
  verifyCommand?: string;
  verification?: VerificationResult;
  maxRepairAttempts?: number;
  repairAttempt?: number;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  skills?: InjectedSkill[];
  runId: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}
