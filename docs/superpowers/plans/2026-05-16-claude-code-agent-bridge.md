# Claude Code Agent Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local bridge that Codex Desktop can call to delegate selected multi-agent stages to the installed Claude Code CLI.

**Architecture:** Implement a small TypeScript command-line bridge with clear provider boundaries. Codex calls the bridge with structured stage input; the bridge invokes `claude -p` for Claude-backed stages, stores run artifacts, and returns a JSON result Codex can read. Codex-native stages remain handled by the current Codex session in v1.

**Tech Stack:** Node.js, TypeScript, Vitest, local Claude Code CLI (`claude -p --output-format json`), git CLI for changed-file inspection.

---

## Context

Spec: `docs/superpowers/specs/2026-05-16-claude-code-agent-bridge-design.md`

Current workspace is not a git repository. If implementation starts in this directory, initialize git first or skip commit steps until the project is moved into a repository.

Detected Claude CLI:

```text
/Users/luozhenkun/.local/bin/claude
```

Relevant Claude flags confirmed by `claude --help`:

- `-p, --print`
- `--output-format json`
- `--permission-mode plan`
- `--permission-mode acceptEdits`
- `--debug-file <path>`
- `--model <model>`
- `--effort <level>`
- `--add-dir <directories...>`

## File Structure

Create:

- `package.json` - scripts and dependencies
- `tsconfig.json` - TypeScript compiler settings
- `vitest.config.ts` - test config
- `src/index.ts` - public exports
- `src/cli.ts` - command entry point and argument parsing
- `src/types.ts` - shared stage, agent, result, and config types
- `src/agents/ClaudeCodeAgent.ts` - local Claude Code CLI provider
- `src/agents/CodexAgent.ts` - v1 placeholder for Codex-handled stages
- `src/agents/AgentProvider.ts` - provider interface
- `src/workflow/AgentRouter.ts` - stage-to-agent routing
- `src/workflow/StageRunner.ts` - invokes providers and writes artifacts
- `src/workflow/AgentCoordinator.ts` - top-level workflow runner
- `src/prompts/stagePrompts.ts` - stage-specific prompt builders
- `src/storage/ResultStore.ts` - `.agent-runs/<run-id>` artifact writer
- `src/utils/exec.ts` - child process helper
- `src/utils/git.ts` - changed-file and diff helpers
- `src/utils/json.ts` - safe JSON parse and output helper
- `tests/AgentRouter.test.ts`
- `tests/stagePrompts.test.ts`
- `tests/ResultStore.test.ts`
- `tests/ClaudeCodeAgent.test.ts`
- `tests/AgentCoordinator.test.ts`
- `README.md`

Do not create a web UI or background service in v1.

## Command Contract

The bridge should expose one primary command:

```bash
npm run bridge -- run-stage \
  --stage plan \
  --agent claude \
  --workspace /absolute/workspace \
  --request-file /absolute/request.md
```

It should print JSON to stdout:

```json
{
  "ok": true,
  "runId": "2026-05-16-001",
  "stage": "plan",
  "agent": "claude",
  "status": "completed",
  "outputPath": ".agent-runs/2026-05-16-001/plan.output.md",
  "logPath": ".agent-runs/2026-05-16-001/claude-plan.log",
  "changedFiles": [],
  "requiresCodex": false,
  "summary": "Claude produced a plan."
}
```

For `agent=codex`, v1 should not try to spawn Codex. It should return:

```json
{
  "ok": true,
  "status": "requires_codex",
  "requiresCodex": true,
  "summary": "This stage should be handled by the current Codex session."
}
```

## Task 1: Scaffold TypeScript Project

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/types.ts`

- [ ] **Step 1: Initialize git if needed**

Run:

```bash
test -d .git || git init
```

Expected: repository initialized or already present.

- [ ] **Step 2: Create package manifest**

Create `package.json`:

```json
{
  "name": "codex-claude-agent-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "claude-agent-bridge": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "bridge": "tsx src/cli.ts"
  },
  "dependencies": {
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create TypeScript config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Create Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false
  }
});
```

- [ ] **Step 5: Create shared types**

Create `src/types.ts`:

```ts
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
```

Create `src/index.ts`:

```ts
export * from "./types.js";
```

- [ ] **Step 6: Install dependencies**

Run:

```bash
npm install
```

Expected: dependencies installed and lockfile created.

- [ ] **Step 7: Run initial checks**

Run:

```bash
npm run typecheck
npm test
```

Expected: typecheck passes; tests should report no tests found or pass after test files are added.

- [ ] **Step 8: Commit**

Run:

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/index.ts src/types.ts
git commit -m "chore: scaffold claude agent bridge"
```

Expected: commit succeeds if git is initialized.

## Task 2: Implement Prompt Builders

**Files:**

- Create: `src/prompts/stagePrompts.ts`
- Test: `tests/stagePrompts.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/stagePrompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildStagePrompt } from "../src/prompts/stagePrompts.js";

describe("buildStagePrompt", () => {
  it("asks planning stages not to edit files", () => {
    const prompt = buildStagePrompt({
      stage: "plan",
      agent: "claude",
      workspace: "/tmp/project",
      request: "Add login cache",
      previousOutputs: {}
    });

    expect(prompt).toContain("Stage: plan");
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("Add login cache");
  });

  it("includes previous outputs for implementation", () => {
    const prompt = buildStagePrompt({
      stage: "implement",
      agent: "claude",
      workspace: "/tmp/project",
      request: "Add login cache",
      previousOutputs: { plan: "Change session.ts" }
    });

    expect(prompt).toContain("Stage: implement");
    expect(prompt).toContain("Change session.ts");
    expect(prompt).toContain("Do not commit");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/stagePrompts.test.ts
```

Expected: FAIL because `src/prompts/stagePrompts.ts` does not exist.

- [ ] **Step 3: Implement prompt builder**

Create `src/prompts/stagePrompts.ts`:

```ts
import type { StageInput } from "../types.js";

export function buildStagePrompt(input: StageInput): string {
  const previous = Object.entries(input.previousOutputs ?? {})
    .map(([stage, output]) => `## Previous ${stage} output\n\n${output}`)
    .join("\n\n");

  const shared = [
    `Stage: ${input.stage}`,
    `Workspace: ${input.workspace}`,
    "",
    "## User request",
    input.request,
    "",
    previous
  ]
    .filter(Boolean)
    .join("\n");

  if (input.stage === "plan") {
    return `${shared}

## Instructions

Create an implementation plan. Do not edit files. Identify likely files to change, risks, and verification steps. Keep the plan scoped to the user request.`;
  }

  if (input.stage === "implement") {
    return `${shared}

## Instructions

Implement the requested change. Keep edits scoped. Do not commit. Report changed files and verification attempts. Avoid destructive git commands.`;
  }

  if (input.stage === "review") {
    return `${shared}

## Instructions

Review the current changes. Prioritize bugs, regressions, and missing tests. Reference files and lines when possible. Separate blocking issues from suggestions. Do not rewrite unrelated code.`;
  }

  return `${shared}

## Instructions

Analyze the request and codebase. Do not edit files. Return findings, risks, and recommended next steps.`;
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/stagePrompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/prompts/stagePrompts.ts tests/stagePrompts.test.ts
git commit -m "feat: add stage prompt builders"
```

Expected: commit succeeds.

## Task 3: Implement Result Store

**Files:**

- Create: `src/storage/ResultStore.ts`
- Test: `tests/ResultStore.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/ResultStore.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResultStore } from "../src/storage/ResultStore.js";

describe("ResultStore", () => {
  it("creates a run directory and writes stage input/output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const store = new ResultStore(workspace);
    const runId = "2026-05-16-001";

    const inputPath = await store.writeStageInput(runId, "plan", "input");
    const outputPath = await store.writeStageOutput(runId, "plan", "output");

    await expect(readFile(inputPath, "utf8")).resolves.toBe("input");
    await expect(readFile(outputPath, "utf8")).resolves.toBe("output");
    expect(inputPath).toContain(".agent-runs");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/ResultStore.test.ts
```

Expected: FAIL because `ResultStore` does not exist.

- [ ] **Step 3: Implement ResultStore**

Create `src/storage/ResultStore.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Stage } from "../types.js";

export class ResultStore {
  constructor(private readonly workspace: string) {}

  runDir(runId: string): string {
    return join(this.workspace, ".agent-runs", runId);
  }

  async ensureRunDir(runId: string): Promise<string> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async writeStageInput(runId: string, stage: Stage, content: string): Promise<string> {
    const dir = await this.ensureRunDir(runId);
    const path = join(dir, `${stage}.input.md`);
    await writeFile(path, content, "utf8");
    return path;
  }

  async writeStageOutput(runId: string, stage: Stage, content: string): Promise<string> {
    const dir = await this.ensureRunDir(runId);
    const path = join(dir, `${stage}.output.md`);
    await writeFile(path, content, "utf8");
    return path;
  }

  async writeLog(runId: string, name: string, content: string): Promise<string> {
    const dir = await this.ensureRunDir(runId);
    const path = join(dir, name);
    await writeFile(path, content, "utf8");
    return path;
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/ResultStore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/storage/ResultStore.ts tests/ResultStore.test.ts
git commit -m "feat: store agent run artifacts"
```

Expected: commit succeeds.

## Task 4: Implement Git and Exec Utilities

**Files:**

- Create: `src/utils/exec.ts`
- Create: `src/utils/git.ts`

- [ ] **Step 1: Implement child process helper**

Create `src/utils/exec.ts`:

```ts
import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function execFileCapture(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; input?: string }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", error => {
      clearTimeout(timer);
      if (!settled) reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (!settled) resolve({ code, stdout, stderr, timedOut: false });
    });

    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
```

- [ ] **Step 2: Implement git helpers**

Create `src/utils/git.ts`:

```ts
import { execFileCapture } from "./exec.js";

export async function isGitRepository(workspace: string): Promise<boolean> {
  const result = await execFileCapture("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: workspace,
    timeoutMs: 5000
  });
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function changedFiles(workspace: string): Promise<string[]> {
  if (!(await isGitRepository(workspace))) return [];

  const result = await execFileCapture("git", ["status", "--short"], {
    cwd: workspace,
    timeoutMs: 5000
  });

  if (result.code !== 0) return [];

  return result.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.slice(3).trim())
    .filter(Boolean);
}
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add src/utils/exec.ts src/utils/git.ts
git commit -m "feat: add process and git helpers"
```

Expected: commit succeeds.

## Task 5: Implement Agent Providers

**Files:**

- Create: `src/agents/AgentProvider.ts`
- Create: `src/agents/CodexAgent.ts`
- Create: `src/agents/ClaudeCodeAgent.ts`
- Test: `tests/ClaudeCodeAgent.test.ts`

- [ ] **Step 1: Write provider interface**

Create `src/agents/AgentProvider.ts`:

```ts
import type { StageInput, StageResult } from "../types.js";

export interface AgentProvider {
  readonly name: StageInput["agent"];
  run(input: StageInput): Promise<StageResult>;
}
```

- [ ] **Step 2: Write Codex placeholder**

Create `src/agents/CodexAgent.ts`:

```ts
import type { AgentProvider } from "./AgentProvider.js";
import type { StageInput, StageResult } from "../types.js";

export class CodexAgent implements AgentProvider {
  readonly name = "codex" as const;

  async run(input: StageInput): Promise<StageResult> {
    return {
      ok: true,
      runId: input.runId ?? "manual",
      stage: input.stage,
      agent: "codex",
      status: "requires_codex",
      changedFiles: [],
      requiresCodex: true,
      summary: "This stage should be handled by the current Codex Desktop session."
    };
  }
}
```

- [ ] **Step 3: Write ClaudeCodeAgent test with fake exec**

Create `tests/ClaudeCodeAgent.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAgent } from "../src/agents/ClaudeCodeAgent.js";

describe("ClaudeCodeAgent", () => {
  it("runs claude with print json mode and stores output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const calls: string[][] = [];
    const agent = new ClaudeCodeAgent({
      claudePath: "claude",
      exec: async (_command, args) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ result: "plan output" }),
          stderr: "",
          timedOut: false
        };
      },
      getChangedFiles: async () => []
    });

    const result = await agent.run({
      stage: "plan",
      agent: "claude",
      workspace,
      request: "Add login cache",
      runId: "2026-05-16-001"
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("completed");
    expect(calls[0]).toContain("-p");
    expect(calls[0]).toContain("--output-format");
    expect(calls[0]).toContain("json");
    expect(calls[0]).toContain("--permission-mode");
    expect(calls[0]).toContain("plan");
  });
});
```

- [ ] **Step 4: Run test to verify failure**

Run:

```bash
npm test -- tests/ClaudeCodeAgent.test.ts
```

Expected: FAIL because `ClaudeCodeAgent` does not exist.

- [ ] **Step 5: Implement ClaudeCodeAgent**

Create `src/agents/ClaudeCodeAgent.ts`:

```ts
import type { AgentProvider } from "./AgentProvider.js";
import type { StageInput, StageResult } from "../types.js";
import { buildStagePrompt } from "../prompts/stagePrompts.js";
import { ResultStore } from "../storage/ResultStore.js";
import { execFileCapture, type ExecResult } from "../utils/exec.js";
import { changedFiles } from "../utils/git.js";

type ExecFn = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; input?: string }
) => Promise<ExecResult>;

export interface ClaudeCodeAgentOptions {
  claudePath?: string;
  exec?: ExecFn;
  getChangedFiles?: (workspace: string) => Promise<string[]>;
}

export class ClaudeCodeAgent implements AgentProvider {
  readonly name = "claude" as const;
  private readonly claudePath: string;
  private readonly exec: ExecFn;
  private readonly getChangedFiles: (workspace: string) => Promise<string[]>;

  constructor(options: ClaudeCodeAgentOptions = {}) {
    this.claudePath = options.claudePath ?? "claude";
    this.exec = options.exec ?? execFileCapture;
    this.getChangedFiles = options.getChangedFiles ?? changedFiles;
  }

  async run(input: StageInput): Promise<StageResult> {
    const runId = input.runId ?? createRunId();
    const store = new ResultStore(input.workspace);
    const prompt = buildStagePrompt({ ...input, runId });
    const inputPath = await store.writeStageInput(runId, input.stage, prompt);
    const logName = `claude-${input.stage}.log`;
    const logPath = await store.writeLog(runId, logName, "");
    const permissionMode = input.stage === "implement" ? "acceptEdits" : "plan";
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      permissionMode,
      "--debug-file",
      logPath
    ];

    if (input.model) args.push("--model", input.model);
    if (input.effort) args.push("--effort", input.effort);
    args.push(prompt);

    const result = await this.exec(this.claudePath, args, {
      cwd: input.workspace,
      timeoutMs: input.timeoutMs ?? 15 * 60 * 1000
    });

    const outputText = extractClaudeOutput(result.stdout);
    const outputPath = await store.writeStageOutput(runId, input.stage, outputText);
    const files = await this.getChangedFiles(input.workspace);

    if (result.timedOut || result.code !== 0) {
      return {
        ok: false,
        runId,
        stage: input.stage,
        agent: "claude",
        status: "failed",
        outputPath,
        logPath,
        changedFiles: files,
        requiresCodex: false,
        summary: `Claude ${input.stage} failed`,
        error: result.timedOut ? "Claude command timed out" : result.stderr
      };
    }

    return {
      ok: true,
      runId,
      stage: input.stage,
      agent: "claude",
      status: "completed",
      outputPath,
      logPath,
      changedFiles: files,
      requiresCodex: false,
      summary: `Claude ${input.stage} completed`
    };
  }
}

function extractClaudeOutput(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    if (typeof parsed.result === "string") return parsed.result;
  } catch {
    // Fall through to raw output.
  }
  return stdout;
}

function createRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${date}-${suffix}`;
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- tests/ClaudeCodeAgent.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/agents tests/ClaudeCodeAgent.test.ts
git commit -m "feat: add claude code agent provider"
```

Expected: commit succeeds.

## Task 6: Implement Routing, Stage Runner, and Coordinator

**Files:**

- Create: `src/workflow/AgentRouter.ts`
- Create: `src/workflow/StageRunner.ts`
- Create: `src/workflow/AgentCoordinator.ts`
- Test: `tests/AgentRouter.test.ts`
- Test: `tests/AgentCoordinator.test.ts`

- [ ] **Step 1: Write router tests**

Create `tests/AgentRouter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AgentRouter } from "../src/workflow/AgentRouter.js";

describe("AgentRouter", () => {
  it("uses explicit stage agent when provided", () => {
    const router = new AgentRouter();
    expect(router.resolve("plan", { plan: "claude" })).toBe("claude");
  });

  it("uses safe defaults", () => {
    const router = new AgentRouter();
    expect(router.resolve("plan", {})).toBe("codex");
    expect(router.resolve("implement", {})).toBe("claude");
    expect(router.resolve("review", {})).toBe("codex");
  });
});
```

- [ ] **Step 2: Implement router**

Create `src/workflow/AgentRouter.ts`:

```ts
import type { AgentName, Stage } from "../types.js";

export type RoutingConfig = Partial<Record<Stage, AgentName>>;

const defaults: Record<Stage, AgentName> = {
  plan: "codex",
  implement: "claude",
  review: "codex",
  analyze: "codex"
};

export class AgentRouter {
  resolve(stage: Stage, config: RoutingConfig): AgentName {
    return config[stage] ?? defaults[stage];
  }
}
```

- [ ] **Step 3: Write coordinator tests**

Create `tests/AgentCoordinator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgentProvider } from "../src/agents/AgentProvider.js";
import { AgentCoordinator } from "../src/workflow/AgentCoordinator.js";
import type { StageInput, StageResult } from "../src/types.js";

class FakeProvider implements AgentProvider {
  constructor(readonly name: StageInput["agent"]) {}
  async run(input: StageInput): Promise<StageResult> {
    return {
      ok: true,
      runId: input.runId ?? "test-run",
      stage: input.stage,
      agent: this.name,
      status: "completed",
      changedFiles: [],
      requiresCodex: false,
      summary: `${this.name} ${input.stage}`
    };
  }
}

describe("AgentCoordinator", () => {
  it("runs stages in order and carries previous outputs", async () => {
    const coordinator = new AgentCoordinator({
      providers: {
        claude: new FakeProvider("claude"),
        codex: new FakeProvider("codex")
      }
    });

    const result = await coordinator.run({
      workspace: "/tmp/project",
      request: "Add login cache",
      stages: ["plan", "implement"],
      routing: { plan: "claude", implement: "claude" },
      runId: "test-run"
    });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].stage).toBe("plan");
    expect(result.results[1].stage).toBe("implement");
  });
});
```

- [ ] **Step 4: Implement StageRunner**

Create `src/workflow/StageRunner.ts`:

```ts
import type { AgentProvider } from "../agents/AgentProvider.js";
import type { StageInput, StageResult } from "../types.js";

export class StageRunner {
  constructor(private readonly providers: Record<string, AgentProvider>) {}

  async run(input: StageInput): Promise<StageResult> {
    const provider = this.providers[input.agent];
    if (!provider) {
      return {
        ok: false,
        runId: input.runId ?? "manual",
        stage: input.stage,
        agent: input.agent,
        status: "failed",
        changedFiles: [],
        requiresCodex: false,
        summary: `No provider registered for ${input.agent}`,
        error: `Unknown agent: ${input.agent}`
      };
    }
    return provider.run(input);
  }
}
```

- [ ] **Step 5: Implement AgentCoordinator**

Create `src/workflow/AgentCoordinator.ts`:

```ts
import type { AgentProvider } from "../agents/AgentProvider.js";
import type { AgentName, Stage, StageResult } from "../types.js";
import { readFile } from "node:fs/promises";
import { AgentRouter, type RoutingConfig } from "./AgentRouter.js";
import { StageRunner } from "./StageRunner.js";

export interface CoordinatorInput {
  workspace: string;
  request: string;
  stages: Stage[];
  routing: RoutingConfig;
  runId?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface CoordinatorResult {
  ok: boolean;
  runId: string;
  results: StageResult[];
  summary: string;
}

export class AgentCoordinator {
  private readonly router = new AgentRouter();
  private readonly runner: StageRunner;

  constructor(options: { providers: Record<AgentName, AgentProvider> }) {
    this.runner = new StageRunner(options.providers);
  }

  async run(input: CoordinatorInput): Promise<CoordinatorResult> {
    const runId = input.runId ?? createRunId();
    const previousOutputs: Record<string, string> = {};
    const results: StageResult[] = [];

    for (const stage of input.stages) {
      const agent = this.router.resolve(stage, input.routing);
      const result = await this.runner.run({
        stage,
        agent,
        workspace: input.workspace,
        request: input.request,
        runId,
        previousOutputs,
        model: input.model,
        effort: input.effort,
        timeoutMs: input.timeoutMs
      });
      results.push(result);
      previousOutputs[stage] = await loadResultOutput(result);
      if (!result.ok) break;
    }

    return {
      ok: results.every(result => result.ok),
      runId,
      results,
      summary: results.map(result => `${result.stage}: ${result.summary}`).join("\n")
    };
  }
}

function createRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${date}-${suffix}`;
}

async function loadResultOutput(result: StageResult): Promise<string> {
  if (!result.outputPath) return result.summary;
  try {
    return await readFile(result.outputPath, "utf8");
  } catch {
    return result.summary;
  }
}
```

- [ ] **Step 6: Update public exports**

Modify `src/index.ts`:

```ts
export * from "./types.js";
export * from "./workflow/AgentCoordinator.js";
export * from "./workflow/AgentRouter.js";
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm test -- tests/AgentRouter.test.ts tests/AgentCoordinator.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/index.ts src/workflow tests/AgentRouter.test.ts tests/AgentCoordinator.test.ts
git commit -m "feat: coordinate routed agent stages"
```

Expected: commit succeeds.

## Task 7: Implement CLI Entry Point

**Files:**

- Create: `src/cli.ts`
- Create: `src/utils/json.ts`

- [ ] **Step 1: Implement JSON helper**

Create `src/utils/json.ts`:

```ts
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
```

- [ ] **Step 2: Implement CLI**

Create `src/cli.ts`:

```ts
#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { ClaudeCodeAgent } from "./agents/ClaudeCodeAgent.js";
import { CodexAgent } from "./agents/CodexAgent.js";
import { AgentCoordinator } from "./workflow/AgentCoordinator.js";
import { printJson } from "./utils/json.js";
import type { AgentName, Stage } from "./types.js";

const program = new Command();

program
  .name("claude-agent-bridge")
  .description("Codex-callable bridge for delegating stages to Claude Code CLI")
  .version("0.1.0");

program
  .command("run-stage")
  .requiredOption("--stage <stage>", "plan | implement | review | analyze")
  .requiredOption("--agent <agent>", "claude | codex")
  .requiredOption("--workspace <path>", "workspace path")
  .requiredOption("--request-file <path>", "file containing user request")
  .option("--run-id <id>", "run id")
  .option("--model <model>", "Claude model")
  .option("--effort <level>", "Claude effort")
  .action(async options => {
    const stage = parseStage(options.stage);
    const agent = parseAgent(options.agent);
    const workspace = resolve(options.workspace);
    const request = await readFile(resolve(options.requestFile), "utf8");

    const coordinator = new AgentCoordinator({
      providers: {
        claude: new ClaudeCodeAgent(),
        codex: new CodexAgent()
      }
    });

    const result = await coordinator.run({
      workspace,
      request,
      stages: [stage],
      routing: { [stage]: agent },
      runId: options.runId,
      model: options.model,
      effort: options.effort
    });

    printJson(result.results[0]);
  });

function parseStage(value: string): Stage {
  if (value === "plan" || value === "implement" || value === "review" || value === "analyze") {
    return value;
  }
  throw new Error(`Invalid stage: ${value}`);
}

function parseAgent(value: string): AgentName {
  if (value === "claude" || value === "codex") return value;
  throw new Error(`Invalid agent: ${value}`);
}

await program.parseAsync();
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Smoke test Codex placeholder**

Run:

```bash
printf "Add login cache" > /tmp/bridge-request.md
npm run bridge -- run-stage --stage review --agent codex --workspace "$PWD" --request-file /tmp/bridge-request.md
```

Expected: JSON with `"requiresCodex": true`.

- [ ] **Step 5: Smoke test Claude planning**

Run:

```bash
printf "Create a short plan for adding login cache. Do not edit files." > /tmp/bridge-request.md
npm run bridge -- run-stage --stage plan --agent claude --workspace "$PWD" --request-file /tmp/bridge-request.md
```

Expected: JSON with `"ok": true`, `"stage": "plan"`, `"agent": "claude"`, and `.agent-runs/<run-id>/plan.output.md` created.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/cli.ts src/utils/json.ts
git commit -m "feat: add codex-callable bridge cli"
```

Expected: commit succeeds.

## Task 8: Document Codex Desktop Usage

**Files:**

- Create: `README.md`

- [ ] **Step 1: Write usage docs**

Create `README.md`:

```md
# Codex Claude Agent Bridge

Local bridge for letting Codex Desktop delegate selected stages to the installed Claude Code CLI.

## Usage From Codex Desktop

Codex can call the bridge from the workspace:

```bash
npm run bridge -- run-stage \
  --stage plan \
  --agent claude \
  --workspace "$PWD" \
  --request-file /tmp/request.md
```

The bridge prints JSON that Codex can read and stores artifacts under `.agent-runs/<run-id>/`.

## Stage Routing

- `plan`: produce a plan, no edits
- `implement`: edit files, no commits
- `review`: review current changes
- `analyze`: analyze only, no edits

## Safety

- Claude Code runs only in the provided workspace.
- Plan, review, and analyze use Claude permission mode `plan`.
- Implement uses Claude permission mode `acceptEdits`.
- The bridge never commits.
- The bridge records prompts, outputs, logs, and changed files.
```

- [ ] **Step 2: Run all checks**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

Run:

```bash
git add README.md
git commit -m "docs: document claude agent bridge usage"
```

Expected: commit succeeds.

## Task 9: Final Verification

**Files:**

- No new files expected.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 2: Run non-edit Claude smoke test**

Run:

```bash
printf "Return a two bullet plan. Do not edit files." > /tmp/bridge-request.md
npm run bridge -- run-stage --stage plan --agent claude --workspace "$PWD" --request-file /tmp/bridge-request.md
```

Expected: JSON result with `ok: true`. Check `.agent-runs/<run-id>/plan.output.md`.

- [ ] **Step 3: Confirm no unintended changes from plan smoke test**

Run:

```bash
git status --short
```

Expected: only expected project files and `.agent-runs/` artifacts are present.

- [ ] **Step 4: Add `.gitignore` if needed**

If `.agent-runs/`, `dist/`, or `node_modules/` appear as untracked files, create `.gitignore`:

```gitignore
node_modules/
dist/
.agent-runs/
```

Then run:

```bash
git add .gitignore
git commit -m "chore: ignore generated bridge artifacts"
```

Expected: generated artifacts ignored.

- [ ] **Step 5: Final status**

Run:

```bash
git status --short
```

Expected: clean working tree, except any intentionally uncommitted local files requested by the user.
