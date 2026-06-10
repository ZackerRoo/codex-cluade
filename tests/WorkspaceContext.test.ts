import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildWorkspaceContext } from "../src/context/WorkspaceContext.js";

describe("buildWorkspaceContext", () => {
  it("summarizes workspace docs, manifests, languages, and symbols", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-workspace-context-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Demo App\n\nA small service for users.\n", "utf8");
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      name: "demo-app",
      scripts: {
        test: "node --test"
      },
      dependencies: {
        zod: "^4.0.0"
      }
    }), "utf8");
    await mkdir(join(workspace, ".codex-claude", "memory"), { recursive: true });
    await writeFile(join(workspace, ".codex-claude", "memory", "project-memory.md"), [
      "# Project memory",
      "",
      "- 2026-06-04 memory-task: completed",
      "  Request: Add remembered feature",
      "  Summary: Previous agent learned this workspace uses service objects."
    ].join("\n"), "utf8");
    await writeFile(join(workspace, "src", "user.ts"), [
      "export class UserService {",
      "  getUserProfile(): string {",
      "    return 'Ada';",
      "  }",
      "}",
      "",
      "export function formatUser(name: string): string {",
      "  return name.toUpperCase();",
      "}"
    ].join("\n"), "utf8");

    const context = await buildWorkspaceContext({ workspace });

    assert.match(context, /Workspace context/);
    assert.match(context, /README\.md/);
    assert.match(context, /Demo App/);
    assert.match(context, /package\.json/);
    assert.match(context, /demo-app/);
    assert.match(context, /Project memory/);
    assert.match(context, /Previous agent learned/);
    assert.match(context, /typescript: 1/);
    assert.match(context, /src\/user\.ts/);
    assert.match(context, /UserService/);
    assert.match(context, /formatUser/);
  });

  it("keeps missing workspaces from blocking agent execution", async () => {
    const context = await buildWorkspaceContext({ workspace: join(tmpdir(), "does-not-exist-context-test") });

    assert.match(context, /Workspace context unavailable/);
  });
});
