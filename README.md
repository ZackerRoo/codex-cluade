# Codex Claude Agent Bridge

Local bridge for letting Codex Desktop delegate selected stages to the installed Claude Code CLI.

## Usage From Codex Desktop

The preferred Codex Desktop integration is the MCP server:

```bash
npm install
npm run build
codex mcp add claude-agent-bridge -- node "$PWD/dist/src/mcpServer.js"
```

After registering the MCP server, Codex can call the `claude_run_stage` tool. This repository also includes a custom subagent config at `.codex/agents/claude-delegate.toml` for multi-agent workflows.

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

## MCP Tool

`claude_run_stage` input:

- `stage`: `plan`, `implement`, `review`, or `analyze`
- `workspace`: absolute workspace path
- `request`: user request or stage prompt
- `runId`: optional artifact run id
- `model`: optional Claude model
- `effort`: optional Claude effort level, one of `low`, `medium`, `high`, `xhigh`, `max`
- `timeoutMs`: optional timeout in milliseconds

The tool returns text plus structured JSON with status, output path, log path, changed files, and errors.

## Stage Routing

- `plan`: produce a plan, no edits
- `implement`: edit files, no commits
- `review`: review current changes
- `analyze`: analyze only, no edits

## Agents

- `claude`: invokes the local Claude Code CLI with `claude -p --output-format json`
- `codex`: returns `requiresCodex: true` so the current Codex Desktop session handles the stage

## Safety

- Claude Code runs only in the provided workspace.
- `plan`, `review`, and `analyze` use Claude permission mode `plan`.
- `implement` uses Claude permission mode `acceptEdits`.
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
