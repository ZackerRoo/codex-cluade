import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentProfile, CategoryDefinition } from "../agents/AgentRegistry.js";

export interface BridgeConfig {
  claudePath?: string;
  categories?: Record<string, Partial<CategoryDefinition>>;
  profiles?: Record<string, Partial<AgentProfile>>;
  defaults?: {
    timeoutMs?: number;
  };
}

export function loadBridgeConfig(cwd = process.cwd(), env = process.env): BridgeConfig {
  const configPath = resolveConfigPath(cwd, env);
  if (!configPath) return {};
  try {
    return normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch (error) {
    throw new Error(`Failed to load bridge config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveConfigPath(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  if (env.CODEX_CLAUDE_CONFIG) {
    return isAbsolute(env.CODEX_CLAUDE_CONFIG) ? env.CODEX_CLAUDE_CONFIG : resolve(cwd, env.CODEX_CLAUDE_CONFIG);
  }
  const local = resolve(cwd, "codex-claude.config.json");
  if (existsSync(local)) return local;
  const user = join(homedir(), ".codex-claude", "config.json");
  if (existsSync(user)) return user;
  return undefined;
}

function normalizeConfig(value: unknown): BridgeConfig {
  if (!isRecord(value)) return {};
  return {
    claudePath: typeof value.claudePath === "string" ? value.claudePath : undefined,
    categories: normalizeRecord(value.categories),
    profiles: normalizeRecord(value.profiles),
    defaults: isRecord(value.defaults) && typeof value.defaults.timeoutMs === "number"
      ? { timeoutMs: value.defaults.timeoutMs }
      : undefined
  };
}

function normalizeRecord(value: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) result[key] = item;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
