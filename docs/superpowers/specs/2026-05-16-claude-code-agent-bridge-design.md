# Claude Code Agent Bridge Design

Date: 2026-05-16

## Goal

Enable Codex Desktop to use the local Claude Code CLI as an agent when the user asks Codex to delegate planning, implementation, review, or analysis work to Claude.

The user should stay inside Codex Desktop. They should be able to write requests such as:

- "plan 用 Claude，实现用 Codex"
- "实现交给 Claude，Codex 帮我 review"
- "让 Claude agent 先分析这个 bug，然后 Codex 修"
- "Claude 负责前端，Codex 负责后端"

Codex remains the coordinating agent. Claude Code is an execution provider that Codex can invoke for selected stages.

## Non-Goals

The first version will not:

- modify Codex Desktop UI
- require the user to run a separate CLI manually
- call Anthropic APIs directly
- implement long-term memory
- allow multiple agents to edit the same files concurrently
- build a web service
- auto-solve complex task decomposition without explicit routing

## Proposed Architecture

```text
Codex Desktop message
  -> AgentCoordinator
      -> AgentRouter
      -> StageRunner
      -> ResultStore
      -> Verifier
  -> Agent providers
      -> CodexAgent
      -> ClaudeCodeAgent
```

### AgentCoordinator

Coordinates the multi-agent workflow for one user request. It decides which stages are needed, asks the router which provider should handle each stage, runs stages in order, stores results, and returns a final summary to Codex.

### AgentRouter

Maps a stage to an agent provider. In the first version, routing is explicit and based on user wording or equivalent structured options:

```text
plan -> claude | codex
implement -> claude | codex
review -> claude | codex
analyze -> claude | codex
```

Default routing:

```text
plan: codex
implement: claude
review: codex
analyze: codex
```

The default keeps Codex responsible for understanding, validation, and user-facing synthesis while allowing Claude Code to perform implementation work.

### StageRunner

Builds a stage prompt, invokes the selected agent provider, waits for completion, and captures the result.

Each stage receives:

- original user request
- current workspace path
- stage type
- previous stage outputs
- relevant constraints
- expected output format

### ClaudeCodeAgent

Wraps the local Claude Code CLI.

Responsibilities:

- locate and validate the Claude Code CLI
- create a stage-specific prompt
- run Claude Code in the target workspace
- capture stdout, stderr, exit status, and timeout state
- report changed files from git when available
- write logs to the run directory

The provider should hide Claude-specific command details from the coordinator.

### CodexAgent

Represents Codex-native execution. In the first version this may be a thin adapter around the current Codex session capabilities. It should expose the same provider shape as `ClaudeCodeAgent` so the coordinator can treat both consistently.

### ResultStore

Stores all inputs and outputs for observability.

Suggested run layout:

```text
.agent-runs/
  2026-05-16-001/
    request.md
    workflow.json
    plan.input.md
    plan.output.md
    implement.input.md
    implement.output.md
    review.input.md
    review.output.md
    claude.log
    codex.log
    summary.md
```

This is important because multi-agent systems are hard to debug without a clear record of which agent did what and why.

### Verifier

Performs lightweight checks after implementation or review stages.

Initial checks:

- inspect git diff when available
- list changed files
- run configured verification command if provided
- report whether verification was skipped, passed, or failed

The verifier should not invent success. If no tests are configured, it must say verification was skipped.

## Workflow

Example user request:

```text
帮我实现登录态缓存，plan 用 Claude，实现用 Claude，review 用 Codex
```

Expected flow:

```text
1. Codex receives the message in Codex Desktop.
2. AgentCoordinator detects requested stages and agent routing.
3. AgentRouter maps plan -> ClaudeCodeAgent.
4. StageRunner sends a planning prompt to Claude Code CLI.
5. ResultStore saves the plan output.
6. AgentRouter maps implement -> ClaudeCodeAgent.
7. StageRunner sends implementation instructions plus the plan to Claude Code CLI.
8. ResultStore saves implementation output and changed files.
9. AgentRouter maps review -> CodexAgent.
10. Codex reviews the request, plan, implementation output, and git diff.
11. Verifier runs available checks.
12. Codex returns a concise final summary to the user.
```

## Prompt Contracts

Each delegated stage should receive a strict prompt contract.

Planning prompt should ask Claude to:

- produce an implementation plan
- identify files likely to change
- avoid editing files
- list risks and verification steps

Implementation prompt should ask Claude to:

- implement the approved plan
- keep changes scoped
- avoid committing
- report changed files and verification attempts

Review prompt should ask the selected reviewer to:

- prioritize bugs, regressions, and missing tests
- reference files and lines when possible
- separate blocking issues from suggestions
- avoid rewriting unrelated code

## Safety Constraints

First version constraints:

- only one external agent edits the workspace at a time
- Claude Code runs in the current workspace, not an arbitrary path
- no destructive git commands are issued by the bridge
- no automatic commit is made
- each Claude run has a timeout
- each run records command, prompt, result, and changed files

## Integration Shape

The preferred integration is a Codex-callable local bridge:

```text
Codex Desktop
  -> local bridge command or MCP tool
  -> Claude Code CLI
  -> run artifacts and result payload
  -> Codex Desktop
```

The bridge can start as a local command because it is simple to test. If Codex Desktop supports exposing it as an MCP tool or plugin, the same underlying provider can be wrapped without changing the core coordinator logic.

## MVP Scope

Version 1 should implement:

- `ClaudeCodeAgent`
- explicit routing for `plan`, `implement`, `review`, and `analyze`
- sequential stage execution
- run artifact storage
- basic git diff and changed file reporting
- Codex-facing summary format

Version 1 should not implement:

- parallel editing
- automatic conflict resolution
- UI controls
- cloud APIs
- multi-repository workflows

## Open Questions

- Which exact Claude Code CLI command and flags are available on this machine?
- Does Codex Desktop expose a custom MCP/plugin path for local tools in this environment?
- Should run artifacts live in `.agent-runs/` or under Codex's existing run/session storage?
- Should the first implementation be TypeScript, Rust, or a small shell-compatible command wrapper?

## Recommendation

Build the local `ClaudeCodeAgent` bridge first, then connect it to Codex's multi-agent coordination path. This gives the desired Codex Desktop user experience while keeping the first implementation testable and reversible.

