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
      assert.ok(tools.tools.some(tool => tool.name === "provider_doctor"));
      assert.ok(tools.tools.some(tool => tool.name === "command_catalog"));
      assert.ok(tools.tools.some(tool => tool.name === "task_preview"));
      assert.ok(tools.tools.some(tool => tool.name === "run_command"));
      assert.ok(tools.tools.some(tool => tool.name === "start_work"));
      assert.ok(tools.tools.some(tool => tool.name === "ultrawork_task"));
      assert.ok(tools.tools.some(tool => tool.name === "plan_work"));
      assert.ok(tools.tools.some(tool => tool.name === "review_work"));
      assert.ok(tools.tools.some(tool => tool.name === "explore_code"));
      assert.ok(tools.tools.some(tool => tool.name === "claude_run_stage"));
      assert.ok(tools.tools.some(tool => tool.name === "delegate_task"));
      assert.ok(tools.tools.some(tool => tool.name === "create_plan"));
      assert.ok(tools.tools.some(tool => tool.name === "execute_plan"));
      assert.ok(tools.tools.some(tool => tool.name === "task_status"));
      assert.ok(tools.tools.some(tool => tool.name === "background_output"));
      assert.ok(tools.tools.some(tool => tool.name === "team_templates"));
      assert.ok(tools.tools.some(tool => tool.name === "team_create"));
      assert.ok(tools.tools.some(tool => tool.name === "team_create_from_template"));
      assert.ok(tools.tools.some(tool => tool.name === "team_coordinator_run"));
      assert.ok(tools.tools.some(tool => tool.name === "team_round_run"));
      assert.ok(tools.tools.some(tool => tool.name === "team_send_message"));
      assert.ok(tools.tools.some(tool => tool.name === "team_inbox"));
      assert.ok(tools.tools.some(tool => tool.name === "team_task_create"));
      assert.ok(tools.tools.some(tool => tool.name === "team_task_update"));
      assert.ok(tools.tools.some(tool => tool.name === "team_task_start"));
      assert.ok(tools.tools.some(tool => tool.name === "team_status"));
      assert.ok(tools.tools.some(tool => tool.name === "team_list"));
      assert.ok(tools.tools.some(tool => tool.name === "task_list"));
      assert.ok(tools.tools.some(tool => tool.name === "agent_catalog"));
      assert.ok(tools.tools.some(tool => tool.name === "task_cancel"));
      assert.ok(tools.tools.some(tool => tool.name === "task_retry"));
      assert.ok(tools.tools.some(tool => tool.name === "task_resume"));
      assert.ok(tools.tools.some(tool => tool.name === "auto_dispatch"));
      assert.ok(tools.tools.some(tool => tool.name === "code_symbols"));
      assert.ok(tools.tools.some(tool => tool.name === "code_definition"));
      assert.ok(tools.tools.some(tool => tool.name === "code_references"));
      assert.ok(tools.tools.some(tool => tool.name === "code_diagnostics"));
    } finally {
      await client.close();
    }
  });
});
