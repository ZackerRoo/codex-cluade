import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileCapture } from "../src/utils/exec.js";

describe("execFileCapture", () => {
  it("streams stdout and stderr chunks while capturing final output", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await execFileCapture(
      process.execPath,
      ["-e", "process.stdout.write('one'); process.stderr.write('two');"],
      {
        cwd: process.cwd(),
        timeoutMs: 10000,
        onStdoutChunk: chunk => stdoutChunks.push(chunk),
        onStderrChunk: chunk => stderrChunks.push(chunk)
      }
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "one");
    assert.equal(result.stderr, "two");
    assert.equal(stdoutChunks.join(""), "one");
    assert.equal(stderrChunks.join(""), "two");
  });

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
