import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TeamStore } from "../src/workflow/TeamStore.js";

describe("TeamStore", () => {
  it("persists teams, messages, inboxes, and shared tasks", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bridge-team-store-"));
    const store = new TeamStore({ rootDir });

    const team = store.create({
      id: "team-test",
      workspace: "/tmp/project",
      goal: "Fix login bug",
      members: [
        { id: "lead", role: "lead", profile: "sisyphus" },
        { id: "coder", role: "implementation", profile: "coder", agent: "claude" }
      ]
    });

    assert.equal(team.id, "team-test");
    assert.equal(team.members.length, 2);

    const message = store.sendMessage({ teamId: team.id, from: "lead", to: "coder", body: "Please inspect auth flow." });
    assert.equal(message?.to, "coder");
    assert.equal(store.inbox(team.id, "coder")?.length, 1);

    const task = store.createTask({ teamId: team.id, title: "Inspect auth flow", assignee: "coder" });
    assert.equal(task?.status, "todo");

    const updated = store.updateTask({ teamId: team.id, taskId: task!.id, status: "in_progress", linkedTaskId: "delegate-1" });
    assert.equal(updated?.status, "in_progress");
    assert.equal(updated?.linkedTaskId, "delegate-1");

    const reloaded = new TeamStore({ rootDir }).get(team.id);
    assert.equal(reloaded?.messages.length, 1);
    assert.equal(reloaded?.tasks[0]?.linkedTaskId, "delegate-1");

    const memory = store.addMemory({ teamId: team.id, scope: "member", memberId: "coder", body: "Use repository auth helpers." });
    assert.equal(memory?.memberId, "coder");
    const member = store.updateMember({ teamId: team.id, memberId: "coder", summary: "Auth helper owner", memory: ["Use repository auth helpers."] });
    assert.equal(member?.summary, "Auth helper owner");
    store.setConflicts(team.id, [{
      id: "conflict-1",
      file: "src/auth.ts",
      taskIds: ["delegate-1", "delegate-2"],
      teamTaskIds: ["team-test-task-1", "team-test-task-2"],
      status: "open",
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z"
    }]);
    const reloadedWithMemory = new TeamStore({ rootDir }).get(team.id);
    assert.equal(reloadedWithMemory?.memory?.length, 1);
    assert.equal(reloadedWithMemory?.members.find(item => item.id === "coder")?.memory?.[0], "Use repository auth helpers.");
    assert.equal(reloadedWithMemory?.conflicts?.[0]?.file, "src/auth.ts");
  });
});
