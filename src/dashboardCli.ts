#!/usr/bin/env node

import { parseArgs } from "node:util";
import { listenDashboard } from "./dashboard/server.js";

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "max-bytes": { type: "string" }
    }
  });

  const port = values.port ? Number(values.port) : undefined;
  const maxBytes = values["max-bytes"] ? Number(values["max-bytes"]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port <= 0)) {
    throw new Error("--port must be a positive integer");
  }
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes <= 0)) {
    throw new Error("--max-bytes must be a positive integer");
  }

  const listener = await listenDashboard({
    host: values.host,
    port,
    maxBytes
  });

  console.log(`Codex Claude Dashboard: ${listener.url}`);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
