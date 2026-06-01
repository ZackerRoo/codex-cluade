# Codex Claude Agent Bridge

Local bridge for letting Codex Desktop delegate selected stages to the installed Claude Code CLI.

## Usage From Codex Desktop

The easiest Codex Desktop integration is the unified MCP + Dashboard runtime:

```bash
npm install -g codex-claude-agent-bridge
claude-agent-bridge setup-codex
```

`setup-codex` prints the exact TOML that should be present in Codex config without changing files. After checking it, write it into `~/.codex/config.toml`:

```bash
claude-agent-bridge setup-codex --write
```

You can also point at explicit provider executables when Codex Desktop cannot inherit your shell `PATH`:

```bash
claude-agent-bridge setup-codex --write \
  --claude-path /Users/me/.local/bin/claude \
  --codex-path /opt/homebrew/bin/codex \
  --gemini-path /opt/homebrew/bin/gemini \
  --opencode-path /opt/homebrew/bin/opencode
```

For a local checkout or git install, build first and then run the same setup command:

```bash
npm install
npm run build
node dist/src/cli.js setup-codex --write
```

The setup command installs this MCP block by default:

```toml
[mcp_servers.claude-agent-bridge]
command = "node"
args = ["/absolute/path/to/dist/src/mcpDashboardServer.js", "--port", "8787"]
env_vars = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]

[mcp_servers.claude-agent-bridge.env]
CLAUDE_CODE_PATH = "claude"
CODEX_CLI_PATH = "codex"
GEMINI_CLI_PATH = "gemini"
OPENCODE_CLI_PATH = "opencode"
```

This unified runtime starts MCP over stdio and a Dashboard on `http://127.0.0.1:8787` in the same process. Dashboard status and MCP tools see the same running tasks, so Dashboard can inspect, cancel, retry, and resume live work.

Manual registration still works if you prefer using Codex CLI directly:

```bash
npm install
npm run build
codex mcp add claude-agent-bridge -- node "$PWD/dist/src/mcpServer.js"
```

If you want the MCP server and Dashboard to share the same live `TaskManager`, use the unified runtime instead:

```bash
npm install
npm run build
codex mcp add claude-agent-bridge -- node "$PWD/dist/src/mcpDashboardServer.js" --port 8787
```

Claude Code CLI authentication must be visible to the MCP server process. For this machine, keep these environment variable names available to Codex:

```toml
[mcp_servers.claude-agent-bridge]
command = "node"
args = ["/absolute/path/to/dist/src/mcpServer.js"]
env_vars = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]

[mcp_servers.claude-agent-bridge.env]
CLAUDE_CODE_PATH = "/Users/luozhenkun/.local/bin/claude"
```

After registering the MCP server, Codex can call the `claude_run_stage` compatibility tool or the newer `delegate_task` orchestration tool. This repository also includes a custom subagent config at `.codex/agents/claude-delegate.toml` for multi-agent workflows.

Example Codex prompt:

```text
Use the claude_delegate agent to run the plan stage for this request through Claude CLI.
Workspace: /absolute/path/to/workspace
Request: <task text>
```

The custom agent is still a Codex subagent shell, but it delegates the assigned stage to the local Claude Code CLI through MCP.

## Direct CLI Usage

Codex can call the bridge from the workspace:

```bash
npm run bridge -- run-stage \
  --stage plan \
  --agent claude \
  --workspace "$PWD" \
  --request-file /tmp/request.md
```

The bridge prints JSON that Codex can read and stores artifacts under `.agent-runs/<run-id>/`.

## MCP Tools

`claude_run_stage` input:

- `stage`: `plan`, `implement`, `review`, or `analyze`
- `workspace`: absolute workspace path
- `request`: user request or stage prompt
- `runId`: optional artifact run id
- `agentSessionId`: optional Claude Code session id to resume
- `model`: optional Claude model
- `effort`: optional Claude effort level, one of `low`, `medium`, `high`, `xhigh`, `max`
- `timeoutMs`: optional timeout in milliseconds

The tool returns text plus structured JSON with status, output path, log path, changed files, and errors.

Claude stage results also include traceability fields when the Claude session can be resolved:

- `agentSessionId`: Claude Code session id
- `agentTranscriptPath`: local Claude transcript JSONL path
- `resumeCommand`: command to resume the Claude session from the correct workspace

`auto_dispatch` is the natural-language entry point for users who do not want to choose stages or profiles manually:

- `workspace`: absolute workspace path
- `request`: natural-language task request
- `mode`: `sync` or `background` (default: `background`)
- `strategy`: `auto`, `direct`, or `plan`
- `planId`: optional plan id when the strategy resolves to `plan`
- `preferredAgent`: optional explicit provider override, such as `claude`, `codex-cli`, `gemini`, `opencode`, or `codex`
- `runId`, `agentSessionId`, `loadSkills`, `model`, `effort`, `timeoutMs`: optional execution controls

With `strategy: auto`, the bridge uses simple, explainable heuristics. Straight implementation requests route directly to the `coder` profile. Requests that explicitly ask to plan first, or include signals such as complex, refactor, architecture, or multi-step work, create a saved plan and then launch execution from that plan.

`delegate_task` is the lower-level orchestration entry point inspired by Oh My OpenCode's `delegate_task` pattern:

- `mode`: `sync` or `background` (default: `sync`)
- `stage`: single stage to run
- `stages`: ordered stage list for multi-stage workflows
- `workspace`: absolute workspace path
- `request`: user request or task prompt
- `category`: routing category, such as `planning`, `coding`, `review`, `analysis`, `fast`, or `heavy`
- `profile`: named routing profile, such as `planner`, `coder`, `reviewer`, `analyst`, `quick`, or `heavy-coder`
- `autoCategory`: infer category and default stage from the request when no routing override is provided
- `preferredAgent`: explicit agent override, `claude`, `codex-cli`, `gemini`, `opencode`, or `codex`
- `agentSessionId`: optional Claude Code session id to resume when a Claude stage runs
- `loadSkills`: configured skill names to inject into the delegated prompt
- `runId`, `model`, `effort`, `timeoutMs`: optional execution controls

Background tasks return a `taskId`. Use:

- `task_status`: inspect a background task
- `background_output`: read task artifacts, Claude logs, and transcript tail
- `task_list`: list tracked background tasks
- `task_cancel`: cancel a background task
- `task_retry`: start a fresh background retry from a previous task
- `task_resume`: start a background retry that resumes the latest Claude session from a previous task
- `agent_catalog`: list available agents, categories, and profiles
- `provider_doctor`: check local provider CLI availability and versions
- `command_catalog`: list slash-style command templates
- `run_command`: run a command template such as `/ultrawork Build a game`
- `code_symbols`: parse a TypeScript/JavaScript file with AST and list classes, interfaces, functions, methods, variables, types, and enums
- `code_definition`: use TypeScript language service or a configured language server to find symbol definitions at a file position
- `code_references`: use TypeScript language service or a configured language server to find symbol references at a file position
- `code_diagnostics`: use TypeScript language service or a configured language server to return syntactic and semantic diagnostics

Command templates:

- `/start-work <request>`: run `auto_dispatch` in background mode
- `/plan-work <request>`: create a saved plan
- `/ultrawork <request>`: create a saved plan with `prometheus`, then launch implementation with `multi-coder` provider fallback
- `/review-work <request>`: launch a reviewer task
- `/multi-work <request>`: launch implementation with `multi-coder` provider fallback

Plan-driven workflow tools:

- `create_plan`: generate a markdown implementation plan and save it under `<workspace>/.codex-claude/plans/<planId>.md`
- `execute_plan`: read a saved plan and delegate the implementation to an executor agent

Every delegated stage now receives an automatic workspace context block before the user request. The context is generated from lightweight, read-only inspection of the target workspace: known docs such as `README.md`, manifests such as `package.json` or `go.mod`, detected source-language counts, and a compact code map from `code_symbols`. The prompt also tells agents to prefer `code_symbols`, `code_definition`, `code_references`, and `code_diagnostics` when those tools are available, so large existing projects can be explored with less blind text search.

Code intelligence tools are read-only. `code_symbols` supports TypeScript, JavaScript, Python, Java, Go, Rust, C, C++, C#, Kotlin, Swift, PHP, and Ruby. TypeScript and JavaScript use the TypeScript compiler AST; the other languages use lightweight syntax-aware symbol extraction for classes, interfaces, structs, functions, methods, traits, protocols, modules, and related top-level constructs.

`code_definition`, `code_references`, and `code_diagnostics` use the TypeScript language service for TypeScript and JavaScript. For other languages, they use a generic stdio LSP adapter. The built-in LSP command mapping is:

- Python: `pyright-langserver --stdio`
- Java: `jdtls`
- Go: `gopls serve`
- Rust: `rust-analyzer`
- C/C++: `clangd`
- C#: `csharp-ls`
- Kotlin: `kotlin-language-server`
- Swift: `sourcekit-lsp`
- PHP: `intelephense --stdio`
- Ruby: `solargraph stdio`

The LSP tools also accept `lspCommand`, `lspArgs`, and `lspTimeoutMs` for explicit per-call overrides. Environment variables such as `PYRIGHT_LANGSERVER_PATH`, `JDTLS_PATH`, `GOPLS_PATH`, `RUST_ANALYZER_PATH`, `CLANGD_PATH`, `CSHARP_LS_PATH`, `KOTLIN_LANGUAGE_SERVER_PATH`, `SOURCEKIT_LSP_PATH`, `INTELEPHENSE_PATH`, and `SOLARGRAPH_PATH` can override default executable names. Positions are 1-based line and column numbers, matching editor UI conventions.

`provider_doctor` also reports language server health. The Dashboard shows a compact `Language servers` summary under `Provider health`, with a collapsible list for Python, Java, Go, Rust, C, C++, C#, Kotlin, Swift, PHP, and Ruby. Missing language servers do not block `code_symbols`, but definition, references, and diagnostics for that language need the corresponding server installed.

Task metadata is persisted under `~/.codex-claude/tasks/<taskId>.json`, so `task_status`, `task_list`, and `background_output` can inspect completed tasks after the MCP server restarts. Persisted task metadata includes requested execution controls such as `model`, `effort`, `timeoutMs`, and injected `skills`; `task_retry` and `task_resume` preserve those controls when launching the follow-up task. If a saved task was `pending` or `running` when the server restarted, it is reported as `interrupted`; use its `resumeCommand` or `agentSessionId` to continue the Claude session.

Workflow parent tasks also persist a long-running state file under `<workspace>/.codex-claude/workflows/<workflowId>.json`. The state tracks phase (`executing`, `reviewing`, `completed`, or failure states), step-to-task mapping, next action, child task statuses, and compact learnings from completed agents. `background_output` exposes this as `workflow-state.md`, and the Dashboard renders it in the task detail panel.

Artifacts still persist under `.agent-runs/<run-id>/`.
Claude transcripts are stored by Claude Code under `~/.claude/projects/<encoded-workspace>/<session-id>.jsonl`; the bridge surfaces the resolved path when available.

`background_output` supports polling with a cursor:

```text
Use background_output with taskId="<task-id>", cursor=0.
```

The response includes `events`, `cursor`, and `nextCursor`. Pass `nextCursor` into the next call to receive only new input/result/CLI stream/log/transcript content. Calls without a cursor include current input, parsed result, raw Claude CLI stdout stream, stderr, debug log, and transcript tails for compatibility. When a Claude transcript is available, the response also includes a structured transcript summary with model names, tool calls, file writes, token usage, and a compact timeline. When a task is tied to a plan file, the response also includes `planSummary` with checklist progress.

## Plan Workflow

For more controlled work, split planning and execution:

```text
Use create_plan:
workspace: /absolute/path/to/project
request: Implement the requested feature.
```

The tool returns:

```text
planId: <generated-plan-id>
planPath: /absolute/path/to/project/.codex-claude/plans/<planId>.md
```

Then execute the plan:

```text
Use execute_plan:
workspace: /absolute/path/to/project
planId: <generated-plan-id>
mode: background
```

`create_plan` defaults to Claude as the planner when no `plannerProfile` or `preferredAgent` is provided, because the built-in `planner` profile is a Codex handoff profile. The planner prompt asks for a markdown checklist using `- [ ]` items. `execute_plan` defaults to the `coder` profile and stores `planId` and `planPath` on the resulting task, so Dashboard and `task_status` can trace which plan drove the implementation.

Plan checklist progress is parsed from the plan markdown:

```md
- [x] Create index.html
- [ ] Verify output
```

Dashboard and `background_output` report completed steps, total steps, progress percentage, and the checklist items.

## Dashboard

The bridge includes a local dashboard for inspecting background tasks and Claude execution traces:

```bash
npm run dashboard
```

By default it listens on `http://127.0.0.1:8765`. You can override the host, port, and output tail size:

```bash
npm run dashboard -- --port 8787 --host 127.0.0.1 --max-bytes 48000
```

Standalone `npm run dashboard` is a read-mostly view over persisted task files. It reads:

- task state from `~/.codex-claude/tasks/*.json`
- artifacts and logs from each workspace's `.agent-runs/<run-id>/`
- Claude transcript summaries from the resolved `agentTranscriptPath`

For live task control, run the unified MCP + Dashboard runtime:

```bash
npm run mcp-dashboard -- --port 8787
```

In this mode the Dashboard and MCP tools share one `TaskManager`, so the Dashboard can:

- submit natural-language work through Auto Dispatch
- run slash-style command templates
- create a normal delegated task
- create a saved implementation plan
- execute a saved plan
- set requested `model`, `effort`, `timeoutMs`, and configured skills for new work
- show requested model controls next to actual Claude transcript models
- show profile and category defaults from `agent_catalog`
- show provider health for Claude, Codex CLI, Gemini, and OpenCode
- launch stability runs that execute the same task across Claude, Codex CLI, Gemini, or other configured providers for multiple iterations
- persist stability run summaries under `~/.codex-claude/stability/*.json`, including success rate, failed counts, average duration, failure samples, and per-task status
- inspect task input, parsed result, raw Claude CLI stream, stderr, debug log, and transcript tail in the Live I/O panel
- cancel currently `pending` or `running` tasks
- retry `failed`, `interrupted`, or `cancelled` tasks
- resume a failed/interrupted/cancelled Claude task when a session id is available

The Dashboard starts in Simple mode. Simple mode keeps the creation form focused on Workspace, Request, Command, and Agent, and shows the task list, task detail, and provider health. Advanced mode exposes lower-level orchestration controls such as Auto Dispatch, Delegate Task, Create Plan, Execute Plan, profile, stage, requested model, effort, timeout, skills, the agent defaults catalog, and stability run reports.

For a real long-running comparison, open Advanced mode and use Stability runs:

```text
Workspace root: /tmp/codex-claude-stability
Providers: claude,codex-cli,gemini
Iterations: 3
Request: Create a small HTML game and include a short README describing how to run it.
Verify command: optional shell command, for example npm test
```

Each provider and iteration gets an isolated workspace under `<workspace root>/<run id>/`. The report updates as tasks finish and can be cancelled while running.

The shared runtime writes its Dashboard URL to stderr so MCP stdout stays protocol-clean. The task creation panel is hidden when running the standalone read-only dashboard.

## Session Continuation

Use `agentSessionId` to continue a prior Claude Code session from the same workspace:

```text
Use delegate_task with profile="coder", agentSessionId="<claude-session-id>".
workspace: /absolute/path/to/project
request: Continue the previous implementation and fix the remaining issue.
```

`task_status` and `background_output` expose the resolved `agentSessionId`, `agentTranscriptPath`, and `resumeCommand` for Claude stages.

## External Config

The server loads an optional JSON config from the first available location:

1. `CODEX_CLAUDE_CONFIG`
2. `./codex-claude.config.json`
3. `~/.codex-claude/config.json`

Example:

```json
{
  "claudePath": "/Users/me/.local/bin/claude",
  "codexPath": "/Applications/Codex.app/Contents/Resources/codex",
  "geminiPath": "/opt/homebrew/bin/gemini",
  "opencodePath": "/opt/homebrew/bin/opencode",
  "defaults": {
    "timeoutMs": 900000
  },
  "concurrency": {
    "maxRunning": 2
  },
  "skills": {
    "html-game": {
      "content": "Build as a single self-contained index.html file. Avoid external assets."
    },
    "project-rules": {
      "path": "./docs/project-rules.md"
    }
  },
  "commands": {
    "frontend-work": {
      "description": "Build frontend tasks with the frontend skill and multi-provider fallback",
      "action": "delegate_task",
      "stage": "implement",
      "profile": "multi-coder",
      "loadSkills": ["html-game"]
    }
  },
  "profiles": {
    "frontend-coder": {
      "description": "Claude implementation profile for frontend tasks",
      "category": "coding",
      "agent": "claude",
      "stages": ["implement"],
      "effort": "high",
      "timeoutMs": 900000,
      "permission": {
        "mode": "bypassPermissions",
        "allowedTools": ["Bash(npm test *)", "Read"],
        "disallowedTools": ["NotebookEdit"]
      },
      "fallbacks": [{ "agent": "codex-cli" }, { "agent": "gemini" }, { "agent": "codex" }]
    }
  },
  "categories": {
    "frontend": {
      "description": "Frontend implementation work",
      "agent": "claude",
      "effort": "high",
      "permission": {
        "mode": "default",
        "allowedTools": ["Bash(git diff *)"],
        "disallowedTools": ["Write", "Edit"]
      },
      "fallbacks": [{ "agent": "codex-cli" }, { "agent": "gemini" }, { "agent": "codex" }]
    }
  }
}
```

Permission policy precedence follows routing: `profile.permission` overrides `category.permission`; if neither is set, stage defaults apply.

`concurrency.maxRunning` limits how many background tasks run at once; additional background tasks remain `pending` until a running task completes, fails, or is cancelled. `skills` entries can be injected with `delegate_task.loadSkills`, either inline with `content` or from a markdown/text file via `path`.

## Stage Routing

- `plan`: produce a plan, no edits
- `implement`: edit files, no commits
- `review`: review current changes
- `analyze`: analyze only, no edits

Category routing:

- `planning`: routes to `codex`
- `coding`: routes to `claude`
- `review`: routes to `codex`
- `analysis`: routes to `codex`
- `fast`: routes to `codex`
- `heavy`: routes to `claude`

Named profiles:

- `planner`: Codex plan stage
- `coder`: Claude implement stage
- `codex-coder`: Codex CLI implement stage
- `gemini-coder`: Gemini CLI implement stage
- `multi-coder`: Claude implement stage with Codex CLI, Gemini, then Codex handoff fallback
- `reviewer`: Codex review stage
- `analyst`: Codex analyze stage
- `quick`: low-effort Codex handoff
- `heavy-coder`: Claude implement stage with higher effort and a longer timeout

Routing precedence is: `preferredAgent` > `profile` > `category` > explicit per-stage routing > stage defaults. If no `stage`, `stages`, `category`, `profile`, or `preferredAgent` is provided, `delegate_task` infers a category from the request and chooses the default stage for that category.

`coding`, `heavy`, `coder`, `multi-coder`, and `heavy-coder` include a runtime fallback chain: try Claude first, then Codex CLI, then Gemini CLI, then Codex handoff with `requiresCodex: true` if local provider CLIs fail. Explicit `preferredAgent` disables fallback because the caller has chosen a concrete agent.

## Agents

- `claude`: invokes the local Claude Code CLI with streaming JSON output
- `codex-cli`: invokes the local Codex CLI with `codex exec --json`
- `gemini`: invokes the local Gemini CLI with `gemini --prompt --output-format stream-json`
- `opencode`: optional OpenCode CLI provider when installed/configured
- `codex`: returns `requiresCodex: true` so the current Codex Desktop session handles the stage

Provider executable paths can be configured with `claudePath`, `codexPath`, `geminiPath`, and `opencodePath` in `codex-claude.config.json`, or with `CLAUDE_CODE_PATH`, `CODEX_CLI_PATH`, `GEMINI_CLI_PATH`, and `OPENCODE_CLI_PATH`.

## Safety

- Claude Code runs only in the provided workspace.
- If your Claude Code default model returns `role 'system' is not supported`, choose a working Claude model explicitly in Dashboard Advanced mode or pass `model` in MCP calls. On this machine, `pa/claude-opus-4-7` worked for the real workflow smoke test.
- `plan`, `review`, and `analyze` use Claude permission mode `default` with edit tools disabled.
- `implement` uses Claude permission mode `bypassPermissions` so Claude Code can run implementation commands without permission prompts.
- Profiles and categories can override Claude `permission.mode`, `allowedTools`, and `disallowedTools` in config.
- The bridge never commits.
- The bridge records prompts, outputs, logs, and changed files.

## Example

```bash
printf "Create a short implementation plan. Do not edit files." > /tmp/request.md
npm run bridge -- run-stage \
  --stage plan \
  --agent claude \
  --workspace "$PWD" \
  --request-file /tmp/request.md
```
