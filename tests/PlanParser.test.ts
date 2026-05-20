import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlanChecklist } from "../src/workflow/PlanParser.js";

describe("parsePlanChecklist", () => {
  it("summarizes markdown checklist progress", () => {
    const summary = parsePlanChecklist([
      "# Plan",
      "- [x] Create index.html",
      "- [ ] Add page text",
      "* [X] Verify output"
    ].join("\n"));

    assert.equal(summary.totalSteps, 3);
    assert.equal(summary.completedSteps, 2);
    assert.equal(summary.progressPercent, 67);
    assert.deepEqual(summary.steps.map(step => step.text), [
      "Create index.html",
      "Add page text",
      "Verify output"
    ]);
  });

  it("returns empty progress when no checklist is present", () => {
    const summary = parsePlanChecklist("No checkbox steps");

    assert.equal(summary.totalSteps, 0);
    assert.equal(summary.completedSteps, 0);
    assert.equal(summary.progressPercent, 0);
  });
});
