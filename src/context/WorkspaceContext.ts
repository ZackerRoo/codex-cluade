import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { inspectCodeSymbols } from "../code/CodeIntelligence.js";

export interface WorkspaceContextOptions {
  workspace: string;
  maxFiles?: number;
  maxDocChars?: number;
  maxManifestChars?: number;
  maxSymbolFiles?: number;
  maxSymbolsPerFile?: number;
}

const DEFAULT_MAX_FILES = 800;
const DEFAULT_MAX_DOC_CHARS = 1_200;
const DEFAULT_MAX_MANIFEST_CHARS = 1_000;
const DEFAULT_MAX_SYMBOL_FILES = 12;
const DEFAULT_MAX_SYMBOLS_PER_FILE = 12;

const IGNORED_DIRS = new Set([
  ".git",
  ".agent-runs",
  ".claude",
  ".codex-claude",
  ".next",
  ".turbo",
  ".venv",
  ".idea",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor"
]);

const DOC_FILES = [
  "README.md",
  "README",
  "AGENTS.md",
  "CLAUDE.md",
  ".codex-claude/context.md"
];

const MANIFEST_FILES = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile"
];

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".cxx",
  ".go",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".pyw",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx"
]);

export async function buildWorkspaceContext(options: WorkspaceContextOptions): Promise<string> {
  const root = resolve(options.workspace);
  if (!existsSync(root)) {
    return `## Workspace context\n\nWorkspace context unavailable: workspace does not exist: ${root}`;
  }

  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      return `## Workspace context\n\nWorkspace context unavailable: workspace is not a directory: ${root}`;
    }

    const files = await discoverFiles(root, options.maxFiles ?? DEFAULT_MAX_FILES);
    const docs = await readKnownFiles(root, DOC_FILES, options.maxDocChars ?? DEFAULT_MAX_DOC_CHARS);
    const manifests = await readKnownFiles(root, MANIFEST_FILES, options.maxManifestChars ?? DEFAULT_MAX_MANIFEST_CHARS);
    const languages = summarizeLanguages(files);
    const codeMap = await summarizeSymbols(root, files, {
      maxSymbolFiles: options.maxSymbolFiles ?? DEFAULT_MAX_SYMBOL_FILES,
      maxSymbolsPerFile: options.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE
    });

    return [
      "## Workspace context",
      "",
      `Workspace: ${root}`,
      "",
      formatKnownFileSection("Project docs", docs),
      "",
      formatKnownFileSection("Manifests", manifests),
      "",
      formatLanguageSection(languages),
      "",
      formatCodeMapSection(codeMap)
    ].filter(Boolean).join("\n");
  } catch (error) {
    return `## Workspace context\n\nWorkspace context unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function discoverFiles(root: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (files.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(path);
        continue;
      }
      if (entry.isFile()) files.push(relative(root, path));
    }
  };
  await walk(root);
  return files;
}

async function readKnownFiles(root: string, candidates: string[], maxChars: number): Promise<Array<{ file: string; content: string }>> {
  const found: Array<{ file: string; content: string }> = [];
  for (const file of candidates) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const fileStat = await stat(path);
    if (!fileStat.isFile()) continue;
    const content = await readFile(path, "utf8");
    found.push({ file, content: truncate(content.trim(), maxChars) });
  }
  return found;
}

function summarizeLanguages(files: string[]): Array<{ language: string; count: number }> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = languageForFile(file);
    if (language === "unknown") continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language));
}

async function summarizeSymbols(
  root: string,
  files: string[],
  options: { maxSymbolFiles: number; maxSymbolsPerFile: number }
): Promise<Array<{ file: string; symbols: string[] }>> {
  const sourceFiles = files
    .filter(file => SOURCE_EXTENSIONS.has(extensionOf(file)))
    .sort(sourceFilePriority)
    .slice(0, options.maxSymbolFiles);
  const summaries: Array<{ file: string; symbols: string[] }> = [];
  for (const file of sourceFiles) {
    try {
      const path = join(root, file);
      const fileStat = await stat(path);
      if (fileStat.size > 150_000) continue;
      const result = await inspectCodeSymbols({ workspace: root, file });
      const symbols = result.symbols
        .slice(0, options.maxSymbolsPerFile)
        .map(symbol => `${symbol.kind} ${symbol.name}`);
      if (symbols.length > 0) summaries.push({ file, symbols });
    } catch {
      // Context should help delegation, not block it.
    }
  }
  return summaries;
}

function formatKnownFileSection(title: string, files: Array<{ file: string; content: string }>): string {
  if (files.length === 0) return `### ${title}\n- none detected`;
  return [
    `### ${title}`,
    ...files.map(file => `- ${file.file}\n${indent(file.content)}`)
  ].join("\n");
}

function formatLanguageSection(languages: Array<{ language: string; count: number }>): string {
  if (languages.length === 0) return "### Languages\n- none detected";
  return [
    "### Languages",
    ...languages.map(item => `- ${item.language}: ${item.count}`)
  ].join("\n");
}

function formatCodeMapSection(codeMap: Array<{ file: string; symbols: string[] }>): string {
  if (codeMap.length === 0) return "### Code map\n- no symbols detected";
  return [
    "### Code map",
    ...codeMap.map(item => `- ${item.file}: ${item.symbols.join(", ")}`)
  ].join("\n");
}

function indent(content: string): string {
  return content.split(/\r?\n/).map(line => `  ${line}`).join("\n");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n  ... truncated`;
}

function sourceFilePriority(a: string, b: string): number {
  const aSrc = a.startsWith("src/") ? 0 : 1;
  const bSrc = b.startsWith("src/") ? 0 : 1;
  return aSrc - bSrc || a.localeCompare(b);
}

function languageForFile(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".mts")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs")) return "javascript";
  if (lower.endsWith(".py") || lower.endsWith(".pyw")) return "python";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".swift")) return "swift";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".cs")) return "csharp";
  if (/\.(?:cc|cpp|cxx|hpp|hh|hxx)$/i.test(lower)) return "cpp";
  if (/\.(?:c|h)$/i.test(lower)) return "c";
  return "unknown";
}

function extensionOf(file: string): string {
  const name = basename(file).toLowerCase();
  const match = name.match(/(\.[^.]+)$/);
  return match?.[1] ?? "";
}
