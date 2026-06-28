export type Stage = "plan" | "implement" | "review" | "analyze";
export type AgentName = "claude" | "codex" | "codex-cli" | "gemini" | "opencode" | "myflicker";
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
  tmpDir?: string;
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

export interface GuardrailIssue {
  kind: "empty_output" | "unfinished_todo" | "comment_density";
  severity: "warning" | "error";
  message: string;
  evidence?: string;
  file?: string;
  continuationTaskId?: string;
}

export interface TaskResultSummary {
  kind: TaskKind;
  status: TaskStatus;
  summary: string;
  quality?: {
    status: "success" | "partial" | "risky" | "failed";
    score: number;
    reasons: string[];
  };
  failure?: {
    category: "verification_failed" | "timeout" | "permission" | "environment" | "empty_output" | "provider_failed" | "cancelled" | "interrupted" | "unknown";
    message: string;
    nextAction: string;
  };
  provider?: AgentName;
  providerAttempts?: AgentName[];
  stages: Stage[];
  changedFiles: string[];
  agentSessions: Array<{
    agent: AgentName;
    sessionId: string;
    resumeCommand?: string;
  }>;
  verification?: {
    command: string;
    status: VerificationResult["status"];
    exitCode?: number | null;
    error?: string;
    tmpDir?: string;
    repairedBy?: string;
  };
  durationMs: number;
  nextSteps: string[];
  guardrails?: GuardrailIssue[];
  error?: string;
  childSummary?: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
  };
}

export interface TaskPreviewWarning {
  code: "workspace_missing" | "dirty_workspace" | "not_git" | "provider_unavailable" | "no_verification" | "large_request" | "sync_long_task";
  severity: "info" | "warning" | "error";
  message: string;
}

export interface TaskExecutionPreviewStep {
  role: string;
  stage: Stage | "workflow";
  provider?: AgentName;
  profile?: AgentProfileName;
  count?: number;
}

export interface TaskPreview {
  strategy: "direct" | "plan" | "ultrawork" | "create_plan" | "execute_plan";
  risk: {
    level: "low" | "medium" | "high";
    score: number;
  };
  executionPlan: TaskExecutionPreviewStep[];
  willModifyFiles: boolean;
  verification: {
    configured: boolean;
    command?: string;
  };
  warnings: TaskPreviewWarning[];
  recommendedAction: string;
  recommendedSetup?: {
    tab?: "command" | "auto" | "delegate" | "create-plan" | "execute-plan";
    command?: string;
    mode?: TaskMode;
    strategy?: "auto" | "direct" | "plan";
    preferredAgent?: AgentName | "";
    stage?: Stage;
    profile?: AgentProfileName;
    requiresConfirmation?: boolean;
    notes: string[];
  };
}

export interface DeliveryReport {
  title: string;
  statusLabel: string;
  summary: string;
  markdown: string;
  sections: Array<{
    title: string;
    items: string[];
  }>;
}

export interface ProjectMemoryEntry {
  taskId: string;
  runId: string;
  status: TaskStatus;
  request: string;
  summary: string;
  changedFiles: string[];
  providerAttempts: AgentName[];
  verificationStatus?: VerificationResult["status"];
  repairTaskId?: string;
  updatedAt: string;
}

export interface ProjectMemory {
  workspace: string;
  updatedAt: string;
  entries: ProjectMemoryEntry[];
}

export type TeamMemberStatus = "active" | "idle" | "done" | "blocked";
export type TeamTaskStatus = "todo" | "in_progress" | "done" | "blocked" | "cancelled";
export type TeamCoordinatorPhase = "idle" | "running" | "merging" | "completed" | "blocked" | "conflict";

export interface TeamMember {
  id: string;
  role: string;
  profile?: AgentProfileName;
  agent?: AgentName;
  status: TeamMemberStatus;
  summary?: string;
  memory?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamMessage {
  id: string;
  teamId: string;
  from: string;
  to: string;
  body: string;
  taskId?: string;
  roundId?: string;
  createdAt: string;
}

export interface TeamTask {
  id: string;
  teamId: string;
  title: string;
  description: string;
  assignee?: string;
  status: TeamTaskStatus;
  linkedTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMemoryEntry {
  id: string;
  scope: "team" | "member";
  memberId?: string;
  body: string;
  sourceMessageId?: string;
  createdAt: string;
}

export interface TeamConflict {
  id: string;
  file: string;
  taskIds: string[];
  teamTaskIds: string[];
  status: "open" | "resolved";
  arbitrationTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamBudget {
  maxRunning?: number;
  maxTasks?: number;
  maxRuntimeMs?: number;
  maxRepairAttempts?: number;
  allowedAgents?: AgentName[];
}

export interface TeamCoordinatorState {
  enabled: boolean;
  autoStart: boolean;
  autoMerge: boolean;
  phase: TeamCoordinatorPhase;
  lastAction?: string;
  mergerTaskId?: string;
  reviewTaskId?: string;
  lastRoundId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTeam {
  id: string;
  workspace: string;
  goal: string;
  lead: string;
  template?: string;
  budget?: TeamBudget;
  coordinator?: TeamCoordinatorState;
  members: TeamMember[];
  messages: TeamMessage[];
  tasks: TeamTask[];
  memory?: TeamMemoryEntry[];
  conflicts?: TeamConflict[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskGitCheckpoint {
  supported: boolean;
  clean: boolean;
  head?: string;
  status?: string[];
  createdAt: string;
  error?: string;
}

export interface TaskGitDiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";
}

export interface TaskGitDiff {
  supported: boolean;
  files: TaskGitDiffFile[];
  patch?: string;
  generatedAt: string;
  error?: string;
}

export interface TaskRollbackState {
  status: "not_available" | "ready" | "completed" | "failed";
  completedAt?: string;
  error?: string;
}

export interface TaskRuntimeSnapshot {
  durationMs: number;
  outputBytes: number;
  outputFiles: Array<{
    path: string;
    bytes: number;
    modifiedAt?: string;
  }>;
  lastOutputAt?: string;
  liveChangedFiles: string[];
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
  continuationOf?: string;
  continuationTaskId?: string;
  maxContinuationAttempts?: number;
  continuationAttempt?: number;
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
  resultSummary?: TaskResultSummary;
  runtime?: TaskRuntimeSnapshot;
  gitCheckpoint?: TaskGitCheckpoint;
  gitDiff?: TaskGitDiff;
  rollback?: TaskRollbackState;
  guardrails?: GuardrailIssue[];
  result?: unknown;
  error?: string;
}
