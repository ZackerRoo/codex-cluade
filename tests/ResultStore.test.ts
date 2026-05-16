import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ResultStore } from "../src/storage/ResultStore.js";

describe("ResultStore", () => {
  it("creates a run directory and writes stage input/output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const store = new ResultStore(workspace);
    const runId = "2026-05-16-001";

    const inputPath = await store.writeStageInput(runId, "plan", "input");
    const outputPath = await store.writeStageOutput(runId, "plan", "output");

    assert.equal(await readFile(inputPath, "utf8"), "input");
    assert.equal(await readFile(outputPath, "utf8"), "output");
    assert.match(inputPath, /\.agent-runs/);
  });
});
