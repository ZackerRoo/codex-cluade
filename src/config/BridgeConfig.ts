import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentProfile, CategoryDefinition } from "../agents/AgentRegistry.js";
import type { CommandDefinition } from "../commands/CommandRegistry.js";

export interface BridgeConfig {
  claudePath?: string;
  codexPath?: string;
  geminiPath?: string;
  opencodePath?: string;
  commands?: Record<string, Partial<CommandDefinition>>;
  categories?: Record<string, Partial<CategoryDefinition>>;
  profiles?: Record<string, Partial<AgentProfile>>;
  skills?: Record<string, SkillConfig>;
  defaults?: {
    timeoutMs?: number;
    claudeModel?: string;
  };
  concurrency?: {
    maxRunning?: number;
  };
}

export interface SkillConfig {
  content?: string;
  path?: string;
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
    codexPath: typeof value.codexPath === "string" ? value.codexPath : undefined,
    geminiPath: typeof value.geminiPath === "string" ? value.geminiPath : undefined,
    opencodePath: typeof value.opencodePath === "string" ? value.opencodePath : undefined,
    commands: normalizeRecord(value.commands),
    categories: normalizeRecord(value.categories),
    profiles: normalizeRecord(value.profiles),
    skills: normalizeRecord(value.skills),
    defaults: normalizeDefaults(value.defaults),
    concurrency: isRecord(value.concurrency) && typeof value.concurrency.maxRunning === "number"
      ? { maxRunning: value.concurrency.maxRunning }
      : undefined
  };
}

function normalizeDefaults(value: unknown): BridgeConfig["defaults"] {
  if (!isRecord(value)) return undefined;
  const defaults: NonNullable<BridgeConfig["defaults"]> = {};
  if (typeof value.timeoutMs === "number") defaults.timeoutMs = value.timeoutMs;
  if (typeof value.claudeModel === "string") defaults.claudeModel = value.claudeModel;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
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
