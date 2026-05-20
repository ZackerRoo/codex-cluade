# Codex Claude Agent Bridge

Local bridge for letting Codex Desktop delegate selected stages to the installed Claude Code CLI.

## Usage From Codex Desktop

The preferred Codex Desktop integration is the MCP server:

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

The unified runtime starts MCP over stdio and a Dashboard on `http://127.0.0.1:8787` in the same process. Dashboard status and MCP tools see the same running tasks, so Dashboard can cancel live `pending` or `running` tasks.

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

`delegate_task` is the higher-level orchestration entry point inspired by Oh My OpenCode's `delegate_task` pattern:

- `mode`: `sync` or `background` (default: `sync`)
- `stage`: single stage to run
- `stages`: ordered stage list for multi-stage workflows
- `workspace`: absolute workspace path
- `request`: user request or task prompt
- `category`: routing category, such as `planning`, `coding`, `review`, `analysis`, `fast`, or `heavy`
- `profile`: named routing profile, such as `planner`, `coder`, `reviewer`, `analyst`, `quick`, or `heavy-coder`
- `autoCategory`: infer category and default stage from the request when no routing override is provided
- `preferredAgent`: explicit agent override, `claude` or `codex`
- `agentSessionId`: optional Claude Code session id to resume when a Claude stage runs
- `loadSkills`: configured skill names to inject into the delegated prompt
- `runId`, `model`, `effort`, `timeoutMs`: optional execution controls

Background tasks return a `taskId`. Use:

- `task_status`: inspect a background task
- `background_output`: read task artifacts, Claude logs, and transcript tail
- `task_list`: list tracked background tasks
- `task_cancel`: cancel a background task
- `agent_catalog`: list available agents, categories, and profiles

Plan-driven workflow tools:

- `create_plan`: generate a markdown implementation plan and save it under `<workspace>/.codex-claude/plans/<planId>.md`
- `execute_plan`: read a saved plan and delegate the implementation to an executor agent

Task metadata is persisted under `~/.codex-claude/tasks/<taskId>.json`, so `task_status`, `task_list`, and `background_output` can inspect completed tasks after the MCP server restarts. If a saved task was `pending` or `running` when the server restarted, it is reported as `interrupted`; use its `resumeCommand` or `agentSessionId` to continue the Claude session.

Artifacts still persist under `.agent-runs/<run-id>/`.
Claude transcripts are stored by Claude Code under `~/.claude/projects/<encoded-workspace>/<session-id>.jsonl`; the bridge surfaces the resolved path when available.

`background_output` supports polling with a cursor:

```text
Use background_output with taskId="<task-id>", cursor=0.
```

The response includes `events`, `cursor`, and `nextCursor`. Pass `nextCursor` into the next call to receive only new output/log/transcript content. Calls without a cursor include current artifact/log tails for compatibility. When a Claude transcript is available, the response also includes a structured transcript summary with model names, tool calls, file writes, token usage, and a compact timeline.

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

`create_plan` defaults to Claude as the planner when no `plannerProfile` or `preferredAgent` is provided, because the built-in `planner` profile is a Codex handoff profile. `execute_plan` defaults to the `coder` profile and stores `planId` and `planPath` on the resulting task, so Dashboard and `task_status` can trace which plan drove the implementation.

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

- create a normal delegated task
- create a saved implementation plan
- execute a saved plan
- cancel currently `pending` or `running` tasks

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
      "fallbacks": [{ "agent": "codex" }]
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
      "fallbacks": [{ "agent": "codex" }]
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
- `reviewer`: Codex review stage
- `analyst`: Codex analyze stage
- `quick`: low-effort Codex handoff
- `heavy-coder`: Claude implement stage with higher effort and a longer timeout

Routing precedence is: `preferredAgent` > `profile` > `category` > explicit per-stage routing > stage defaults. If no `stage`, `stages`, `category`, `profile`, or `preferredAgent` is provided, `delegate_task` infers a category from the request and chooses the default stage for that category.

`coding`, `heavy`, `coder`, and `heavy-coder` include a runtime fallback chain: try Claude first, then fall back to Codex with `requiresCodex: true` if Claude fails. Explicit `preferredAgent` disables fallback because the caller has chosen a concrete agent.

## Agents

- `claude`: invokes the local Claude Code CLI with `claude -p --output-format json`
- `codex`: returns `requiresCodex: true` so the current Codex Desktop session handles the stage

## Safety

- Claude Code runs only in the provided workspace.
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
