#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createTaskTools, runClaudeStageTool, type TaskToolSet } from "./mcp/tools.js";

const stageSchema = z.enum(["plan", "implement", "review", "analyze"]);
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]).optional();
const agentSchema = z.enum(["claude", "codex", "codex-cli", "gemini", "opencode", "myflicker"]).optional();
const modeSchema = z.enum(["sync", "background"]).optional();
const autoDispatchStrategySchema = z.enum(["auto", "direct", "plan"]).optional();

export function createServer(options: { taskTools?: TaskToolSet } = {}): McpServer {
  const server = new McpServer({
    name: "claude-agent-bridge",
    version: "0.1.0"
  });
  const taskTools = options.taskTools ?? createTaskTools();

  server.registerTool(
    "provider_doctor",
    {
      title: "Provider doctor",
      description: "Check local provider CLI availability and version for Claude, Codex CLI, Gemini, OpenCode, and MyFlicker.",
      inputSchema: {},
      annotations: {
        title: "Provider doctor",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => taskTools.providerDoctorTool()
  );

  server.registerTool(
    "command_catalog",
    {
      title: "Command catalog",
      description: "List slash-style command templates such as /start-work and /plan-work.",
      inputSchema: {},
      annotations: {
        title: "Command catalog",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => taskTools.commandCatalogTool()
  );

  server.registerTool(
    "task_preview",
    {
      title: "Task preview",
      description: "Preview strategy, agents, risk, warnings, and recommended action before launching a task.",
      inputSchema: {
        command: z.string().optional().describe("Optional slash command, such as /ultrawork or /start-work."),
        workspace: z.string().min(1).describe("Absolute workspace path where the task would run."),
        request: z.string().optional().describe("Natural-language request to preview."),
        mode: modeSchema.describe("sync or background mode to preview."),
        strategy: autoDispatchStrategySchema.describe("Optional auto-dispatch strategy."),
        stage: stageSchema.optional().describe("Optional delegated stage."),
        profile: z.string().optional().describe("Optional routing profile."),
        preferredAgent: agentSchema.describe("Optional explicit agent override."),
        verifyCommand: z.string().optional().describe("Optional verification command.")
      },
      annotations: {
        title: "Task preview",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.taskPreviewTool(args)
  );

  server.registerTool(
    "run_command",
    {
      title: "Run command",
      description: "Run a slash-style command template through the bridge workflow.",
      inputSchema: {
        command: z.string().min(1).describe("Command name or full slash command, such as /start-work build a game."),
        workspace: z.string().min(1).describe("Absolute workspace path where the command should run."),
        request: z.string().optional().describe("Request text when not embedded in command."),
        mode: modeSchema.describe("sync waits for completion; background returns a task id."),
        strategy: autoDispatchStrategySchema.describe("Optional strategy for auto-dispatch commands."),
        planId: z.string().optional().describe("Optional plan id for plan commands."),
        planPath: z.string().optional().describe("Optional plan path for execute-plan commands."),
        runId: z.string().optional().describe("Optional run id for artifacts and task tracking."),
        agentSessionId: z.string().optional().describe("Optional Claude session id to resume when Claude runs."),
        preferredAgent: agentSchema.describe("Optional explicit agent override."),
        loadSkills: z.array(z.string()).optional().describe("Configured skill names to inject into delegated prompts."),
        model: z.string().optional().describe("Optional model argument for compatible providers."),
        effort: effortSchema.describe("Optional effort level."),
        timeoutMs: z.number().positive().optional().describe("Optional timeout in milliseconds."),
        verifyCommand: z.string().optional().describe("Optional shell command to verify the completed task, such as npm test."),
        maxRepairAttempts: z.number().int().min(0).optional().describe("How many automatic repair tasks to launch when verification fails.")
      },
      annotations: {
        title: "Run command",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.runCommandTool(args)
  );

  server.registerTool(
    "claude_run_stage",
    {
      title: "Run Claude Code stage",
      description:
        "Delegate a plan, implement, review, or analyze stage to the local Claude Code CLI and return the captured result.",
      inputSchema: {
        stage: stageSchema.describe("Stage to run with Claude Code."),
        workspace: z.string().min(1).describe("Absolute workspace path where Claude Code should run."),
        request: z.string().min(1).describe("User request or stage prompt to send to Claude Code."),
        runId: z.string().optional().describe("Optional run id for .agent-runs artifacts."),
        agentSessionId: z.string().optional().describe("Optional Claude session id to resume."),
        loadSkills: z.array(z.string()).optional().describe("Configured skill names to inject into the delegated prompt."),
        model: z.string().optional().describe("Optional Claude model argument."),
        effort: effortSchema.describe("Optional Claude effort level."),
        timeoutMs: z.number().positive().optional().describe("Optional timeout in milliseconds.")
      },
      annotations: {
        title: "Run Claude Code stage",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => runClaudeStageTool(args)
  );

  server.registerTool(
    "auto_dispatch",
    {
      title: "Auto dispatch",
      description:
        "Natural-language task entrypoint. Chooses direct Claude implementation or a create_plan then execute_plan workflow.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute workspace path where the task should run."),
        request: z.string().min(1).describe("Natural-language user request."),
        mode: modeSchema.describe("sync waits for completion; background returns a task id."),
        strategy: autoDispatchStrategySchema.describe("auto infers direct vs plan; direct skips planning; plan creates and executes a saved plan."),
        planId: z.string().optional().describe("Optional plan id when strategy resolves to plan."),
        runId: z.string().optional().describe("Optional run id for the implementation task."),
        agentSessionId: z.string().optional().describe("Optional Claude session id to resume when Claude runs."),
        preferredAgent: agentSchema.describe("Optional explicit agent override for the selected workflow."),
        loadSkills: z.array(z.string()).optional().describe("Configured skill names to inject into delegated prompts."),
        model: z.string().optional().describe("Optional model argument for compatible providers."),
        effort: effortSchema.describe("Optional effort level."),
        timeoutMs: z.number().positive().optional().describe("Optional timeout in milliseconds."),
        verifyCommand: z.string().optional().describe("Optional shell command to verify the completed implementation."),
        maxRepairAttempts: z.number().int().min(0).optional().describe("How many automatic repair tasks to launch when verification fails.")
      },
      annotations: {
        title: "Auto dispatch",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.autoDispatchTool(args)
  );

  server.registerTool(
    "delegate_task",
    {
      title: "Delegate task",
      description:
        "Route one or more stages to Codex or Claude by preferred agent or category. Supports sync and background modes.",
      inputSchema: {
        mode: modeSchema.describe("sync waits for completion; background returns a task id."),
        stage: stageSchema.optional().describe("Single stage to run. Use stages for multi-stage workflows."),
        stages: z.array(stageSchema).optional().describe("Ordered stages to run."),
        workspace: z.string().min(1).describe("Absolute workspace path where the task should run."),
        request: z.string().min(1).describe("User request or task prompt."),
        category: z.string().optional().describe("Routing category such as planning, coding, review, analysis, fast, or heavy."),
        profile: z.string().optional().describe("Named routing profile such as planner, coder, reviewer, analyst, quick, or heavy-coder."),
        autoCategory: z.boolean().optional().describe("Infer a category from the request when category/profile/preferredAgent are omitted."),
        preferredAgent: agentSchema.describe("Explicit agent override."),
        runId: z.string().optional().describe("Optional run id for artifacts and task tracking."),
        agentSessionId: z.string().optional().describe("Optional Claude session id to resume when a Claude stage runs."),
        loadSkills: z.array(z.string()).optional().describe("Configured skill names to inject into the delegated prompt."),
        model: z.string().optional().describe("Optional model argument for compatible providers."),
        effort: effortSchema.describe("Optional effort level."),
        timeoutMs: z.number().positive().optional().describe("Optional timeout in milliseconds."),
        verifyCommand: z.string().optional().describe("Optional shell command to verify the completed task."),
        maxRepairAttempts: z.number().int().min(0).optional().describe("How many automatic repair tasks to launch when verification fails.")
      },
      annotations: {
        title: "Delegate task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.delegateTaskTool(args)
  );

  server.registerTool(
    "create_plan",
    {
      title: "Create plan",
      description: "Generate a markdown implementation plan and save it under the workspace .codex-claude/plans directory.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute workspace path where the plan belongs."),
        request: z.string().min(1).describe("User request to plan."),
        planId: z.string().optional().describe("Optional plan id. Defaults to a generated id."),
        plannerProfile: z.string().optional().describe("Optional planner profile. Defaults to Claude when omitted."),
        preferredAgent: agentSchema.describe("Optional planner agent override."),
        loadSkills: z.array(z.string()).optional().describe("Configured skill names to inject into the planning prompt."),
        model: z.string().optional().describe("Optional model argument for compatible providers."),
        effort: effortSchema.describe("Optional effort level."),
        timeoutMs: z.number().positive().optional().describe("Optional timeout in milliseconds.")
      },
      annotations: {
        title: "Create plan",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.createPlanTool(args)
  );

  server.registerTool(
    "execute_plan",
    {
      title: "Execute plan",
      description: "Read a saved markdown plan and delegate implementation to an executor agent.",
      inputSchema: {
        mode: modeSchema.describe("sync waits for completion; background returns a task id."),
        workspace: z.string().min(1).describe("Absolute workspace path where the plan should execute."),
        planId: z.string().optional().describe("Plan id under .codex-claude/plans."),
        planPath: z.string().optional().describe("Absolute or workspace-relative plan path."),
        request: z.string().optional().describe("Optional extra instruction to append to the execution prompt."),
        executorProfile: z.string().optional().describe("Optional executor profile. Defaults to coder."),
        preferredAgent: agentSchema.describe("Optional executor agent override."),
        runId: z.string().optional().describe("Optional run id for artifacts and task tracking."),
        agentSessionId: z.string().optional().describe("Optional Claude session id to resume when a Claude stage runs."),
        loadSkills: z.array(z.string()).optional().describe("Configured skill names to inject into the execution prompt."),
        model: z.string().optional().describe("Optional model argument for compatible providers."),
        effort: effortSchema.describe("Optional effort level."),
        timeoutMs: z.number().positive().optional().describe("Optional timeout in milliseconds."),
        verifyCommand: z.string().optional().describe("Optional shell command to verify the completed plan execution."),
        maxRepairAttempts: z.number().int().min(0).optional().describe("How many automatic repair tasks to launch when verification fails.")
      },
      annotations: {
        title: "Execute plan",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.executePlanTool(args)
  );

  server.registerTool(
    "task_status",
    {
      title: "Task status",
      description: "Read status and result metadata for a background delegated task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id returned by delegate_task.")
      },
      annotations: {
        title: "Task status",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.taskStatusTool(args)
  );

  server.registerTool(
    "background_output",
    {
      title: "Background output",
      description: "Read task artifacts, Claude logs, and transcript tail for a background delegated task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id returned by delegate_task."),
        maxBytes: z.number().positive().optional().describe("Maximum bytes to read from each output/log file."),
        cursor: z.number().nonnegative().optional().describe("Incremental output cursor returned by the previous background_output call.")
      },
      annotations: {
        title: "Background output",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.backgroundOutputTool(args)
  );

  server.registerTool(
    "project_memory",
    {
      title: "Project memory",
      description: "Read the workspace project memory that is injected into future delegated agent prompts.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute workspace path whose .codex-claude/memory should be read.")
      },
      annotations: {
        title: "Project memory",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.projectMemoryTool(args)
  );

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "List background delegated tasks tracked by the current MCP server process.",
      inputSchema: {},
      annotations: {
        title: "List tasks",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => taskTools.taskListTool()
  );

  server.registerTool(
    "agent_catalog",
    {
      title: "Agent catalog",
      description: "List available agents, routing categories, and named delegation profiles.",
      inputSchema: {},
      annotations: {
        title: "Agent catalog",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => taskTools.agentCatalogTool()
  );

  server.registerTool(
    "code_symbols",
    {
      title: "Code symbols",
      description: "Use TypeScript/JavaScript AST parsing to list symbols in a source file.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute workspace path."),
        file: z.string().min(1).describe("Workspace-relative or absolute TypeScript/JavaScript file path.")
      },
      annotations: {
        title: "Code symbols",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.codeSymbolsTool(args)
  );

  server.registerTool(
    "code_definition",
    {
      title: "Code definition",
      description: "Use the TypeScript language service to find definitions at a file position.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute workspace path."),
        file: z.string().min(1).describe("Workspace-relative or absolute TypeScript/JavaScript file path."),
        line: z.number().int().positive().describe("1-based line number."),
        column: z.number().int().positive().describe("1-based column number."),
        lspCommand: z.string().optional().describe("Optional explicit language server command for non-TypeScript languages."),
        lspArgs: z.array(z.string()).optional().describe("Optional explicit language server args."),
        lspTimeoutMs: z.number().int().positive().optional().describe("Optional language server request timeout.")
      },
      annotations: {
        title: "Code definition",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.codeDefinitionTool(args)
  );

  server.registerTool(
    "code_references",
    {
      title: "Code references",
      description: "Use the TypeScript language service to find references at a file position.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute workspace path."),
        file: z.string().min(1).describe("Workspace-relative or absolute TypeScript/JavaScript file path."),
        line: z.number().int().positive().describe("1-based line number."),
        column: z.number().int().positive().describe("1-based column number."),
        lspCommand: z.string().optional().describe("Optional explicit language server command for non-TypeScript languages."),
        lspArgs: z.array(z.string()).optional().describe("Optional explicit language server args."),
        lspTimeoutMs: z.number().int().positive().optional().describe("Optional language server request timeout.")
      },
      annotations: {
        title: "Code references",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.codeReferencesTool(args)
  );

  server.registerTool(
    "code_diagnostics",
    {
      title: "Code diagnostics",
      description: "Use the TypeScript language service to report syntactic and semantic diagnostics.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute workspace path."),
        files: z.array(z.string()).optional().describe("Optional workspace-relative or absolute files to inspect."),
        maxDiagnostics: z.number().int().positive().optional().describe("Maximum diagnostics to return."),
        lspCommand: z.string().optional().describe("Optional explicit language server command for non-TypeScript languages."),
        lspArgs: z.array(z.string()).optional().describe("Optional explicit language server args."),
        lspTimeoutMs: z.number().int().positive().optional().describe("Optional language server request timeout.")
      },
      annotations: {
        title: "Code diagnostics",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.codeDiagnosticsTool(args)
  );

  server.registerTool(
    "task_cancel",
    {
      title: "Cancel task",
      description: "Cancel a running background delegated task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id returned by delegate_task.")
      },
      annotations: {
        title: "Cancel task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.taskCancelTool(args)
  );

  server.registerTool(
    "task_retry",
    {
      title: "Retry task",
      description: "Start a fresh background retry from a previous delegated task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id to retry.")
      },
      annotations: {
        title: "Retry task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.taskRetryTool(args)
  );

  server.registerTool(
    "task_resume",
    {
      title: "Resume task",
      description: "Start a background retry that resumes the latest Claude session from a previous task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id to resume from.")
      },
      annotations: {
        title: "Resume task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async args => taskTools.taskResumeTool(args)
  );

  server.registerTool(
    "task_rollback",
    {
      title: "Rollback task",
      description: "Rollback git changes made by a completed task when its checkpoint started clean.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task id to roll back.")
      },
      annotations: {
        title: "Rollback task",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async args => taskTools.taskRollbackTool(args)
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
