import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandRegistry, parseCommandText } from "../src/commands/CommandRegistry.js";

describe("CommandRegistry", () => {
  it("lists built-in slash command templates", () => {
    const registry = new CommandRegistry();
    const names = registry.list().map(command => command.name);

    assert.ok(names.includes("start-work"));
    assert.ok(names.includes("plan-work"));
    assert.ok(names.includes("ultrawork"));
    assert.ok(names.includes("review-work"));
    assert.ok(names.includes("multi-work"));
    assert.ok(names.includes("explore"));
    assert.ok(names.includes("frontend-work"));
    assert.ok(names.includes("sisyphus-work"));
    assert.ok(names.includes("momus-review"));
    assert.equal(registry.get("/start-work")?.action, "auto_dispatch");
    assert.equal(registry.get("/ultrawork")?.action, "ultrawork");
    assert.equal(registry.get("/ultrawork")?.plannerProfile, "prometheus");
    assert.equal(registry.get("/ultrawork")?.executorProfile, "multi-coder");
    assert.equal(registry.get("/plan-work")?.plannerProfile, "prometheus");
    assert.equal(registry.get("/momus-review")?.profile, "momus");
  });

  it("parses slash command text into command name and request", () => {
    assert.deepEqual(parseCommandText("/start-work build a tetris game"), {
      name: "start-work",
      request: "build a tetris game"
    });
  });

  it("merges external command definitions", () => {
    const registry = new CommandRegistry({
      commands: {
        "ship-it": {
          description: "Custom release command",
          action: "delegate_task",
          stage: "review",
          profile: "reviewer"
        }
      }
    });

    assert.equal(registry.get("ship-it")?.description, "Custom release command");
    assert.equal(registry.get("ship-it")?.profile, "reviewer");
  });
});
