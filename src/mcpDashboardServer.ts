#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";
import { BridgeRuntime } from "./BridgeRuntime.js";
import { createServer } from "./mcpServer.js";

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string" },
      port: { type: "string" }
    }
  });
  const host = values.host ?? "127.0.0.1";
  const port = values.port ? Number(values.port) : 8787;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("--port must be a positive integer");
  }

  const runtime = new BridgeRuntime();
  const dashboard = runtime.createDashboardHttpServer();
  await new Promise<void>((resolve, reject) => {
    dashboard.once("error", reject);
    dashboard.listen(port, host, () => {
      dashboard.off("error", reject);
      resolve();
    });
  });
  console.error(`Codex Claude Dashboard: http://${host}:${port}`);

  const mcpServer = createServer({ taskTools: runtime.taskTools });
  await mcpServer.connect(new StdioServerTransport());
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
