import type { StageInput } from "../types.js";

export function buildStagePrompt(input: StageInput): string {
  const previous = Object.entries(input.previousOutputs ?? {})
    .map(([stage, output]) => `## Previous ${stage} output\n\n${output}`)
    .join("\n\n");
  const skills = (input.skills ?? [])
    .map(skill => `### ${skill.name}\n\n${skill.content}`)
    .join("\n\n");

  const shared = [
    `Stage: ${input.stage}`,
    `Workspace: ${input.workspace}`,
    "",
    input.rolePrompt ? `## Agent role\n${input.rolePrompt}` : "",
    "",
    input.workspaceContext ? `${formatWorkspaceContext(input.workspaceContext)}\n\n${codeIntelligenceGuidance()}` : "",
    "",
    "## User request",
    input.request,
    "",
    skills ? `## Injected skills\n\n${skills}` : "",
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

function formatWorkspaceContext(context: string): string {
  return context.trimStart().startsWith("## Workspace context")
    ? context
    : `## Workspace context\n\n${context}`;
}

function codeIntelligenceGuidance(): string {
  return [
    "## Code intelligence guidance",
    "",
    "When code intelligence tools are available, prefer them before broad text search for code navigation:",
    "- Use code_symbols to map important files and exported APIs.",
    "- Use code_definition to jump from usage to implementation.",
    "- Use code_references before changing shared symbols.",
    "- Use code_diagnostics to verify TypeScript/JavaScript or configured LSP diagnostics when relevant."
  ].join("\n");
}
