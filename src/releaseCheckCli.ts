#!/usr/bin/env node

import { parseArgs } from "node:util";
import { runReleaseCheck } from "./install/ReleaseCheck.js";
import { printJson } from "./utils/json.js";

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cwd: { type: "string" },
      "timeout-ms": { type: "string" }
    }
  });
  const timeoutMs = values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive number");
  }
  const result = await runReleaseCheck({
    cwd: values.cwd,
    timeoutMs
  });
  printJson({
    command: "release:check",
    ...result
  });
  if (!result.ok) process.exitCode = 1;
}

main(process.argv.slice(2)).catch(error => {
  printJson({
    command: "release:check",
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
