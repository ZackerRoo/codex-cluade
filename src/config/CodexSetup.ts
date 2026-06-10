import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const BRIDGE_TABLE = "mcp_servers.claude-agent-bridge";
const BRIDGE_ENV_TABLE = "mcp_servers.claude-agent-bridge.env";

export interface CodexMcpConfigOptions {
  serverPath: string;
  port?: number;
  claudePath?: string;
  codexPath?: string;
  geminiPath?: string;
  opencodePath?: string;
  myflickerPath?: string;
}

export interface SetupCodexMcpConfigOptions extends CodexMcpConfigOptions {
  configPath?: string;
  existingContent?: string;
  write?: boolean;
}

export interface SetupCodexMcpConfigResult {
  configPath: string;
  snippet: string;
  content: string;
  written: boolean;
}

export function defaultCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}

export function buildCodexMcpConfig(options: CodexMcpConfigOptions): string {
  const port = String(options.port ?? 8787);
  const envEntries: Array<[string, string]> = [
    ["CLAUDE_CODE_PATH", options.claudePath ?? "claude"],
    ["CODEX_CLI_PATH", options.codexPath ?? "codex"],
    ["GEMINI_CLI_PATH", options.geminiPath ?? "gemini"],
    ["OPENCODE_CLI_PATH", options.opencodePath ?? "opencode"],
    ["MYFLICKER_CLI_PATH", options.myflickerPath ?? "m"]
  ];

  return [
    `[${BRIDGE_TABLE}]`,
    `command = "node"`,
    `args = [${tomlString(options.serverPath)}, "--port", ${tomlString(port)}]`,
    `env_vars = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]`,
    "",
    `[${BRIDGE_ENV_TABLE}]`,
    ...envEntries.map(([key, value]) => `${key} = ${tomlString(value)}`)
  ].join("\n");
}

export async function setupCodexMcpConfig(options: SetupCodexMcpConfigOptions): Promise<SetupCodexMcpConfigResult> {
  const configPath = options.configPath ?? defaultCodexConfigPath();
  const snippet = buildCodexMcpConfig(options);
  const existingContent = options.existingContent ?? await readOptional(configPath);
  const content = replaceBridgeSections(existingContent, snippet);

  if (options.write) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, content, "utf8");
  }

  return {
    configPath,
    snippet,
    content,
    written: Boolean(options.write)
  };
}

function replaceBridgeSections(content: string, snippet: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];

  for (let index = 0; index < lines.length;) {
    const table = parseTableHeader(lines[index]);
    if (table === BRIDGE_TABLE || table === BRIDGE_ENV_TABLE) {
      index += 1;
      while (index < lines.length && !parseTableHeader(lines[index])) {
        index += 1;
      }
      continue;
    }
    kept.push(lines[index]);
    index += 1;
  }

  const prefix = trimTrailingBlankLines(kept).join("\n");
  return prefix.length > 0 ? `${prefix}\n\n${snippet}\n` : `${snippet}\n`;
}

function parseTableHeader(line: string): string | undefined {
  const match = line.match(/^\s*\[([^\]]+)]\s*$/);
  return match?.[1];
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === "") {
    trimmed.pop();
  }
  return trimmed;
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return "";
    throw error;
  }
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
