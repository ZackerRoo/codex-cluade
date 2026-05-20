import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("mcpServer", () => {
  it("exposes claude_run_stage over stdio MCP", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/src/mcpServer.js"],
      cwd: process.cwd(),
      stderr: "pipe"
    });
    const client = new Client({ name: "bridge-test", version: "0.1.0" });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool => tool.name === "claude_run_stage"));
      assert.ok(tools.tools.some(tool => tool.name === "delegate_task"));
      assert.ok(tools.tools.some(tool => tool.name === "create_plan"));
      assert.ok(tools.tools.some(tool => tool.name === "execute_plan"));
      assert.ok(tools.tools.some(tool => tool.name === "task_status"));
      assert.ok(tools.tools.some(tool => tool.name === "background_output"));
      assert.ok(tools.tools.some(tool => tool.name === "task_list"));
      assert.ok(tools.tools.some(tool => tool.name === "agent_catalog"));
      assert.ok(tools.tools.some(tool => tool.name === "task_cancel"));
      assert.ok(tools.tools.some(tool => tool.name === "task_retry"));
      assert.ok(tools.tools.some(tool => tool.name === "task_resume"));
    } finally {
      await client.close();
    }
  });
});
