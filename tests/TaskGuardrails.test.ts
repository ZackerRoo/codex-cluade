import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DelegatedTask } from "../src/types.js";
import { evaluateTaskGuardrails } from "../src/workflow/TaskGuardrails.js";

describe("evaluateTaskGuardrails", () => {
  it("flags successful tasks that produced no useful output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-guardrail-empty-"));

    const issues = await evaluateTaskGuardrails(createTask(workspace, {
      result: {
        ok: true,
        results: [{
          ok: true,
          runId: "empty-output-task",
          stage: "implement",
          agent: "claude",
          status: "completed",
          changedFiles: [],
          requiresCodex: false,
          summary: "   "
        }]
      }
    }));

    assert.equal(issues[0]?.kind, "empty_output");
    assert.equal(issues[0]?.severity, "error");
  });

  it("warns when agent output still contains unchecked todo items", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-guardrail-todo-"));

    const issues = await evaluateTaskGuardrails(createTask(workspace, {
      result: {
        ok: true,
        results: [{
          ok: true,
          runId: "todo-task",
          stage: "implement",
          agent: "claude",
          status: "completed",
          changedFiles: ["README.md"],
          requiresCodex: false,
          summary: "Implemented core files.\n- [ ] Wire persistence"
        }]
      }
    }));

    assert.ok(issues.some(issue => issue.kind === "unfinished_todo" && issue.severity === "warning"));
  });

  it("warns when changed source files are dominated by comments", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-guardrail-comments-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    const lines = [
      ...Array.from({ length: 24 }, (_, index) => `// generated explanation ${index + 1}`),
      "export function run(): string {",
      "  return \"ok\";",
      "}"
    ];
    await writeFile(join(workspace, "src", "comment-heavy.ts"), `${lines.join("\n")}\n`, "utf8");

    const issues = await evaluateTaskGuardrails(createTask(workspace, {
      result: {
        ok: true,
        results: [{
          ok: true,
          runId: "comment-task",
          stage: "implement",
          agent: "claude",
          status: "completed",
          changedFiles: ["src/comment-heavy.ts"],
          requiresCodex: false,
          summary: "implemented"
        }]
      }
    }));

    const commentIssue = issues.find(issue => issue.kind === "comment_density");
    assert.equal(commentIssue?.severity, "warning");
    assert.match(commentIssue?.message ?? "", /comment/i);
  });
});

function createTask(workspace: string, overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: "guardrail-task",
    mode: "background",
    status: "completed",
    workspace,
    request: "Implement feature",
    stages: ["implement"],
    preferredAgent: "claude",
    runId: "guardrail-task",
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:01.000Z",
    ...overrides
  };
}
