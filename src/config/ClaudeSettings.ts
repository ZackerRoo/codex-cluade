import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileCapture } from "../utils/exec.js";

export const FALLBACK_CLAUDE_MODEL = "opus[1m]";

export function resolveDefaultClaudeModel(options: {
  configuredModel?: string;
  env?: NodeJS.ProcessEnv;
  settingsPath?: string;
} = {}): string {
  const env = options.env ?? process.env;
  return options.configuredModel
    ?? env.CODEX_CLAUDE_MODEL
    ?? readClaudeSettingsModel(options.settingsPath ?? env.CODEX_CLAUDE_SETTINGS_PATH)
    ?? FALLBACK_CLAUDE_MODEL;
}

export function readClaudeSettingsModel(settingsPath = join(homedir(), ".claude", "settings.json")): string | undefined {
  if (!existsSync(settingsPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { model?: unknown };
    return typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function loadShellClaudeEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv | undefined> {
  const shell = env.SHELL || "/bin/zsh";
  const result = await execFileCapture(shell, ["-lic", "env"], {
    cwd,
    timeoutMs: 5_000,
    env
  });
  if (result.timedOut || result.code !== 0) return undefined;
  const freshEnv: NodeJS.ProcessEnv = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index);
    if (!isClaudeEnvKey(key)) continue;
    freshEnv[key] = line.slice(index + 1);
  }
  return Object.keys(freshEnv).length > 0 ? freshEnv : undefined;
}

function isClaudeEnvKey(key: string): boolean {
  return key === "ANTHROPIC_BASE_URL"
    || key === "ANTHROPIC_AUTH_TOKEN"
    || key === "ANTHROPIC_API_KEY"
    || key.startsWith("CLAUDE_CODE_");
}
