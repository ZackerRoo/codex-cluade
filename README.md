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
