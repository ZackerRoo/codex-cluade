import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileCapture } from "../src/utils/exec.js";

describe("execFileCapture", () => {
  it("terminates child process when aborted", async () => {
    const controller = new AbortController();
    const promise = execFileCapture(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: process.cwd(),
      timeoutMs: 10000,
      signal: controller.signal
    });

    controller.abort();
    const result = await promise;

    assert.equal(result.timedOut, false);
    assert.equal(result.code, null);
  });
});
