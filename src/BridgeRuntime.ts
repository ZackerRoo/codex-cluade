import { AgentRegistry } from "./agents/AgentRegistry.js";
import type { ClaudeCodeAgentOptions } from "./agents/ClaudeCodeAgent.js";
import { createDashboardServer } from "./dashboard/server.js";
import { loadBridgeConfig, type BridgeConfig } from "./config/BridgeConfig.js";
import { createTaskManager, createTaskTools } from "./mcp/tools.js";
import type { TaskToolSet } from "./mcp/tools.js";
import type { TaskManager } from "./workflow/TaskManager.js";
import type { TaskStore } from "./workflow/TaskStore.js";

export interface BridgeRuntimeOptions {
  config?: BridgeConfig;
  claude?: ClaudeCodeAgentOptions;
  taskStore?: TaskStore;
}

export class BridgeRuntime {
  readonly config: BridgeConfig;
  readonly registry: AgentRegistry;
  readonly taskManager: TaskManager;
  readonly taskTools: TaskToolSet;

  constructor(options: BridgeRuntimeOptions = {}) {
    this.config = options.config ?? loadBridgeConfig();
    this.registry = new AgentRegistry(this.config);
    this.taskManager = createTaskManager({
      config: this.config,
      registry: this.registry,
      claude: options.claude,
      taskStore: options.taskStore
    });
    this.taskTools = createTaskTools({
      config: this.config,
      claude: options.claude,
      taskManager: this.taskManager
    });
  }

  createDashboardHttpServer(): ReturnType<typeof createDashboardServer> {
    return createDashboardServer({ taskManager: this.taskManager });
  }
}
