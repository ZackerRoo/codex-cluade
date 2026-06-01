import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, relative } from "node:path";
import ts from "typescript";
import { LspClient, type LspServerSpec } from "./LspClient.js";

export interface CodeLocation {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export interface CodeSymbol extends CodeLocation {
  name: string;
  kind: string;
  exported: boolean;
}

export interface CodePositionArgs {
  workspace: string;
  file: string;
  line: number;
  column: number;
  lspCommand?: string;
  lspArgs?: string[];
  lspTimeoutMs?: number;
}

export interface CodeSymbolsArgs {
  workspace: string;
  file: string;
}

export interface CodeDiagnosticsArgs {
  workspace: string;
  files?: string[];
  maxDiagnostics?: number;
  lspCommand?: string;
  lspArgs?: string[];
  lspTimeoutMs?: number;
}

export async function inspectCodeSymbols(args: CodeSymbolsArgs): Promise<{ ok: true; file: string; symbols: CodeSymbol[] }> {
  const file = resolveWorkspacePath(args.workspace, args.file);
  const content = readFileSync(file, "utf8");
  if (!isTypeScriptLike(file)) {
    return { ok: true, file, symbols: inspectLineSymbols(file, content) };
  }
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind(file));
  const symbols: CodeSymbol[] = [];

  const visit = (node: ts.Node): void => {
    const symbol = nodeToSymbol(source, node);
    if (symbol) symbols.push(symbol);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { ok: true, file, symbols };
}

function inspectLineSymbols(file: string, content: string): CodeSymbol[] {
  const language = languageForFile(file);
  const symbols: CodeSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const match of matchLineSymbols(language, line)) {
      const column = Math.max(1, line.indexOf(match.name) + 1);
      symbols.push({
        file,
        line: index + 1,
        column,
        endLine: index + 1,
        endColumn: column + match.name.length,
        text: line.trim(),
        name: match.name,
        kind: match.kind,
        exported: /(?:^|\s)(export|public|pub|open)\s/.test(line)
      });
    }
  }
  return symbols;
}

function matchLineSymbols(language: string, line: string): Array<{ kind: string; name: string }> {
  const matches: Array<{ kind: string; name: string }> = [];
  const add = (kind: string, regex: RegExp, group = 1): void => {
    const match = line.match(regex);
    if (match?.[group]) matches.push({ kind, name: match[group] });
  };

  if (language === "python") {
    add("class", /^\s*class\s+([A-Za-z_]\w*)/);
    add("function", /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/);
    return matches;
  }
  if (language === "go") {
    add("struct", /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/);
    add("interface", /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/);
    add("function", /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/);
    return matches;
  }
  if (language === "rust") {
    add("struct", /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/);
    add("enum", /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/);
    add("trait", /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/);
    add("function", /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/);
    return matches;
  }
  if (language === "ruby") {
    add("class", /^\s*class\s+([A-Za-z_]\w*)/);
    add("module", /^\s*module\s+([A-Za-z_]\w*)/);
    add("function", /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/);
    return matches;
  }
  if (language === "php") {
    add("class", /^\s*(?:final\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/);
    add("interface", /^\s*interface\s+([A-Za-z_]\w*)/);
    add("trait", /^\s*trait\s+([A-Za-z_]\w*)/);
    add("enum", /^\s*enum\s+([A-Za-z_]\w*)/);
    add("function", /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/);
    return matches;
  }
  if (language === "swift") {
    add("class", /^\s*(?:public|private|internal|open|final|\s)*class\s+([A-Za-z_]\w*)/);
    add("struct", /^\s*(?:public|private|internal|open|\s)*struct\s+([A-Za-z_]\w*)/);
    add("protocol", /^\s*(?:public|private|internal|open|\s)*protocol\s+([A-Za-z_]\w*)/);
    add("enum", /^\s*(?:public|private|internal|open|\s)*enum\s+([A-Za-z_]\w*)/);
    add("function", /^\s*(?:public|private|internal|open|static|\s)*func\s+([A-Za-z_]\w*)/);
    return matches;
  }
  if (language === "kotlin") {
    add("class", /^\s*(?:public|private|internal|open|data|sealed|abstract|\s)*class\s+([A-Za-z_]\w*)/);
    add("interface", /^\s*(?:public|private|internal|\s)*interface\s+([A-Za-z_]\w*)/);
    add("object", /^\s*(?:public|private|internal|\s)*object\s+([A-Za-z_]\w*)/);
    add("function", /^\s*(?:public|private|internal|suspend|inline|override|\s)*fun\s+(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)/);
    return matches;
  }
  if (language === "java" || language === "csharp") {
    add("class", /^\s*(?:public|private|protected|internal|static|final|abstract|sealed|partial|\s)*class\s+([A-Za-z_]\w*)/);
    add("interface", /^\s*(?:public|private|protected|internal|\s)*interface\s+([A-Za-z_]\w*)/);
    add("enum", /^\s*(?:public|private|protected|internal|\s)*enum\s+([A-Za-z_]\w*)/);
    add("method", /^\s*(?:public|private|protected|internal|static|final|abstract|virtual|override|async|\s)*[A-Za-z_][\w<>\[\],.?]*\s+([A-Za-z_]\w*)\s*\(/);
    return matches.filter(match => !["if", "for", "while", "switch", "catch"].includes(match.name));
  }
  if (language === "c" || language === "cpp") {
    add("class", /^\s*(?:template\s*<[^>]+>\s*)?class\s+([A-Za-z_]\w*)/);
    add("struct", /^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/);
    add("enum", /^\s*(?:typedef\s+)?enum\s+(?:class\s+)?([A-Za-z_]\w*)/);
    add("function", /^\s*(?:static|inline|extern|constexpr|virtual|\s)*[A-Za-z_][\w:<>\*&\s]+?\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/);
    return matches.filter(match => !["if", "for", "while", "switch", "catch"].includes(match.name));
  }
  return matches;
}

export async function inspectCodeDefinition(args: CodePositionArgs): Promise<{ ok: true; definitions: CodeLocation[] }> {
  if (!isTypeScriptLike(args.file)) {
    const client = await createLspClient(args.workspace, args.file, args);
    try {
      return { ok: true, definitions: await client.definition(resolveWorkspacePath(args.workspace, args.file), args.line, args.column) };
    } finally {
      await client.stop();
    }
  }
  const service = createLanguageService(args.workspace, args.file);
  const file = resolveWorkspacePath(args.workspace, args.file);
  const offset = positionToOffset(service, file, args.line, args.column);
  const definitions = service.languageService.getDefinitionAtPosition(file, offset) ?? [];
  return {
    ok: true,
    definitions: definitions.map(definition => spanToLocation(service, definition.fileName, definition.textSpan))
  };
}

export async function inspectCodeReferences(args: CodePositionArgs): Promise<{ ok: true; references: CodeLocation[] }> {
  if (!isTypeScriptLike(args.file)) {
    const client = await createLspClient(args.workspace, args.file, args);
    try {
      return { ok: true, references: await client.references(resolveWorkspacePath(args.workspace, args.file), args.line, args.column) };
    } finally {
      await client.stop();
    }
  }
  const service = createLanguageService(args.workspace, args.file);
  const file = resolveWorkspacePath(args.workspace, args.file);
  const offset = positionToOffset(service, file, args.line, args.column);
  const references = service.languageService.getReferencesAtPosition(file, offset) ?? [];
  return {
    ok: true,
    references: references.map(reference => spanToLocation(service, reference.fileName, reference.textSpan))
  };
}

export async function inspectCodeDiagnostics(args: CodeDiagnosticsArgs): Promise<{ ok: true; diagnostics: Array<CodeLocation & { code?: number | string; category: string; message: string }> }> {
  const firstFile = args.files?.[0];
  if (firstFile && !isTypeScriptLike(firstFile)) {
    const files = (args.files ?? []).map(file => resolveWorkspacePath(args.workspace, file));
    const client = await createLspClient(args.workspace, firstFile, args);
    try {
      const diagnostics = (await Promise.all(files.map(file => client.documentDiagnostics(file)))).flat();
      return { ok: true, diagnostics: diagnostics.slice(0, args.maxDiagnostics ?? 100) };
    } finally {
      await client.stop();
    }
  }
  const service = createLanguageService(args.workspace, args.files?.[0]);
  const files = args.files?.map(file => resolveWorkspacePath(args.workspace, file)) ?? service.files;
  const diagnostics = files.flatMap(file => [
    ...service.languageService.getSyntacticDiagnostics(file),
    ...service.languageService.getSemanticDiagnostics(file)
  ]);
  return {
    ok: true,
    diagnostics: diagnostics.slice(0, args.maxDiagnostics ?? 100).map(diagnostic => diagnosticToLocation(service, diagnostic))
  };
}

async function createLspClient(
  workspace: string,
  file: string,
  args: { lspCommand?: string; lspArgs?: string[]; lspTimeoutMs?: number }
): Promise<LspClient> {
  const spec = lspServerSpec(file, args);
  const client = new LspClient(spec, resolve(workspace));
  await client.start();
  return client;
}

function lspServerSpec(file: string, args: { lspCommand?: string; lspArgs?: string[]; lspTimeoutMs?: number }): LspServerSpec {
  if (args.lspCommand) {
    return { command: args.lspCommand, args: args.lspArgs ?? [], timeoutMs: args.lspTimeoutMs };
  }
  const language = languageForFile(file);
  const byLanguage: Record<string, LspServerSpec> = {
    python: { command: process.env.PYRIGHT_LANGSERVER_PATH ?? "pyright-langserver", args: ["--stdio"] },
    java: { command: process.env.JDTLS_PATH ?? "jdtls", args: [] },
    go: { command: process.env.GOPLS_PATH ?? "gopls", args: ["serve"] },
    rust: { command: process.env.RUST_ANALYZER_PATH ?? "rust-analyzer", args: [] },
    c: { command: process.env.CLANGD_PATH ?? "clangd", args: [] },
    cpp: { command: process.env.CLANGD_PATH ?? "clangd", args: [] },
    csharp: { command: process.env.CSHARP_LS_PATH ?? "csharp-ls", args: [] },
    kotlin: { command: process.env.KOTLIN_LANGUAGE_SERVER_PATH ?? "kotlin-language-server", args: [] },
    swift: { command: process.env.SOURCEKIT_LSP_PATH ?? "sourcekit-lsp", args: [] },
    php: { command: process.env.INTELEPHENSE_PATH ?? "intelephense", args: ["--stdio"] },
    ruby: { command: process.env.SOLARGRAPH_PATH ?? "solargraph", args: ["stdio"] }
  };
  const spec = byLanguage[language];
  if (!spec) throw new Error(`No language server mapping for file: ${file}`);
  return { ...spec, timeoutMs: args.lspTimeoutMs };
}

function nodeToSymbol(source: ts.SourceFile, node: ts.Node): CodeSymbol | undefined {
  const named = node as ts.Node & { name?: ts.Node };
  if (!named.name || !ts.isIdentifier(named.name)) return undefined;
  const kind = symbolKind(node);
  if (!kind) return undefined;
  return {
    ...nodeLocation(source, node),
    name: named.name.text,
    kind,
    exported: isExported(node)
  };
}

function symbolKind(node: ts.Node): string | undefined {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isPropertyDeclaration(node)) return "property";
  if (ts.isVariableDeclaration(node)) return "variable";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  return undefined;
}

function isExported(node: ts.Node): boolean {
  return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
}

function nodeLocation(source: ts.SourceFile, node: ts.Node): CodeLocation {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: source.fileName,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
    text: node.getText(source).split(/\r?\n/, 1)[0] ?? ""
  };
}

function createLanguageService(workspace: string, preferredFile?: string): {
  languageService: ts.LanguageService;
  files: string[];
  getSourceFile(file: string): ts.SourceFile;
} {
  const root = resolve(workspace);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  const parsed = configPath ? parseTsConfig(configPath) : undefined;
  const fallbackFile = preferredFile ? resolveWorkspacePath(root, preferredFile) : undefined;
  const parsedFiles = parsed?.fileNames ?? [];
  const files = parsed
    ? (fallbackFile && !parsedFiles.includes(fallbackFile) ? [...parsedFiles, fallbackFile] : parsedFiles)
    : (fallbackFile ? [fallbackFile] : discoverScriptFiles(root));
  const options = parsed?.options ?? {
    allowJs: true,
    checkJs: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext
  };
  const versions = new Map(files.map(file => [file, "0"]));
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: fileName => versions.get(fileName) ?? "0",
    getScriptSnapshot: fileName => existsSync(fileName) ? ts.ScriptSnapshot.fromString(readFileSync(fileName, "utf8")) : undefined,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: compilerOptions => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath
  };
  const languageService = ts.createLanguageService(host);
  return {
    languageService,
    files,
    getSourceFile(file: string): ts.SourceFile {
      const source = languageService.getProgram()?.getSourceFile(file);
      if (!source) throw new Error(`Source file not found in TypeScript program: ${relative(root, file)}`);
      return source;
    }
  };
}

function discoverScriptFiles(root: string): string[] {
  return ts.sys.readDirectory(
    root,
    [".ts", ".tsx", ".js", ".jsx"],
    ["node_modules", ".git", "dist", "build", "coverage"],
    undefined,
    8
  );
}

function parseTsConfig(configPath: string): ts.ParsedCommandLine {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
}

function positionToOffset(service: ReturnType<typeof createLanguageService>, file: string, line: number, column: number): number {
  const source = service.getSourceFile(file);
  return source.getPositionOfLineAndCharacter(Math.max(0, line - 1), Math.max(0, column - 1));
}

function spanToLocation(service: ReturnType<typeof createLanguageService>, file: string, span: ts.TextSpan): CodeLocation {
  const source = service.getSourceFile(file);
  const start = source.getLineAndCharacterOfPosition(span.start);
  const end = source.getLineAndCharacterOfPosition(span.start + span.length);
  const text = source.text.slice(span.start, span.start + span.length).split(/\r?\n/, 1)[0] ?? "";
  return {
    file,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
    text
  };
}

function diagnosticToLocation(service: ReturnType<typeof createLanguageService>, diagnostic: ts.Diagnostic): CodeLocation & { code: number; category: string; message: string } {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const file = diagnostic.file?.fileName ?? "";
  const fallback = { file, line: 0, column: 0, endLine: 0, endColumn: 0, text: "" };
  const location = diagnostic.file && diagnostic.start !== undefined
    ? spanToLocation(service, diagnostic.file.fileName, { start: diagnostic.start, length: diagnostic.length ?? 0 })
    : fallback;
  return {
    ...location,
    code: Number(diagnostic.code),
    category: ts.DiagnosticCategory[diagnostic.category],
    message
  };
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isTypeScriptLike(file: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(file);
}

function languageForFile(file: string): string {
  const lower = file.toLowerCase();
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

function resolveWorkspacePath(workspace: string, file: string): string {
  const root = resolve(workspace);
  const resolved = isAbsolute(file) ? resolve(file) : resolve(join(root, file));
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Path is outside workspace: ${file}`);
  }
  return resolved;
}
