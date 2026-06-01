import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CodeLocation } from "./CodeIntelligence.js";

export interface LspServerSpec {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

export interface LspDiagnosticLocation extends CodeLocation {
  code?: string | number;
  category: string;
  message: string;
}

export class LspClient {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdout = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private diagnostics = new Map<string, LspDiagnosticLocation[]>();

  constructor(
    private readonly spec: LspServerSpec,
    private readonly workspace: string
  ) {}

  async start(): Promise<void> {
    this.process = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.workspace,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process.stdout.on("data", chunk => this.onStdout(chunk));
    this.process.on("error", error => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    this.process.on("exit", (code, signal) => {
      if (code && code !== 0) this.rejectAll(new Error(`Language server exited with code ${code}${signal ? ` signal ${signal}` : ""}`));
    });
    try {
      const result = await this.request("initialize", {
        processId: null,
        rootUri: pathToFileURL(this.workspace).href,
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false }
          }
        }
      });
      if (!result) throw new Error("Language server initialize failed");
      this.notify("initialized", {});
    } catch (error) {
      this.process.kill();
      throw error;
    }
  }

  async definition(file: string, line: number, column: number): Promise<CodeLocation[]> {
    this.openDocument(file);
    const result = await this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(file).href },
      position: { line: line - 1, character: column - 1 }
    });
    return normalizeLocations(result).map(location => locationToCodeLocation(location));
  }

  async references(file: string, line: number, column: number): Promise<CodeLocation[]> {
    this.openDocument(file);
    const result = await this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(file).href },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: true }
    });
    return normalizeLocations(result).map(location => locationToCodeLocation(location));
  }

  async documentDiagnostics(file: string): Promise<LspDiagnosticLocation[]> {
    const uri = pathToFileURL(file).href;
    this.openDocument(file);
    await new Promise(resolve => setTimeout(resolve, this.spec.timeoutMs ?? 1_500));
    return this.diagnostics.get(uri) ?? [];
  }

  async stop(): Promise<void> {
    try {
      await this.request("shutdown", null);
      this.notify("exit", {});
    } catch {
      // Best-effort shutdown.
    }
    this.process?.kill();
  }

  private openDocument(file: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(file).href,
        languageId: languageIdForFile(file),
        version: 1,
        text: readFileSync(file, "utf8")
      }
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const timeout = this.spec.timeoutMs ?? 5_000;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Language server request timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    const body = JSON.stringify(message);
    this.process?.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private onStdout(chunk: Buffer): void {
    this.stdout = Buffer.concat([this.stdout, chunk]);
    while (true) {
      const headerEnd = this.stdout.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.stdout.slice(0, headerEnd).toString("utf8");
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1] ?? 0);
      const start = headerEnd + 4;
      if (this.stdout.length < start + length) return;
      const message = JSON.parse(this.stdout.slice(start, start + length).toString("utf8")) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: unknown;
      };
      this.stdout = this.stdout.slice(start + length);
      this.handleMessage(message);
    }
  }

  private handleMessage(message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown }): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Language server request failed"));
      else pending.resolve(message.result);
      return;
    }
    const params = message.params;
    if (message.method === "textDocument/publishDiagnostics" && isDiagnosticParams(params)) {
      this.diagnostics.set(params.uri, params.diagnostics.map(diagnostic => diagnosticToCodeLocation(params.uri, diagnostic)));
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function normalizeLocations(value: unknown): LspLocation[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(item => {
    if (isLocation(item)) return [item];
    if (isLocationLink(item)) return [{ uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange }];
    return [];
  });
}

function locationToCodeLocation(location: LspLocation): CodeLocation {
  const file = fileURLToPath(location.uri);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return {
    file,
    line: location.range.start.line + 1,
    column: location.range.start.character + 1,
    endLine: location.range.end.line + 1,
    endColumn: location.range.end.character + 1,
    text: sliceRangeText(text, location.range)
  };
}

function diagnosticToCodeLocation(uri: string, diagnostic: { range: LspRange; severity?: number; code?: string | number; message: string }): LspDiagnosticLocation {
  return {
    ...locationToCodeLocation({ uri, range: diagnostic.range }),
    code: diagnostic.code,
    category: severityName(diagnostic.severity),
    message: diagnostic.message
  };
}

function sliceRangeText(text: string, range: LspRange): string {
  const lines = text.split(/\r?\n/);
  const line = lines[range.start.line] ?? "";
  return line.slice(range.start.character, range.end.line === range.start.line ? range.end.character : undefined);
}

function isLocation(value: unknown): value is LspLocation {
  return typeof value === "object" && value !== null && typeof (value as LspLocation).uri === "string" && Boolean((value as LspLocation).range);
}

function isLocationLink(value: unknown): value is LspLocationLink {
  return typeof value === "object" && value !== null && typeof (value as LspLocationLink).targetUri === "string" && Boolean((value as LspLocationLink).targetRange);
}

function isDiagnosticParams(value: unknown): value is { uri: string; diagnostics: Array<{ range: LspRange; severity?: number; code?: string | number; message: string }> } {
  return typeof value === "object" && value !== null && typeof (value as { uri?: unknown }).uri === "string" && Array.isArray((value as { diagnostics?: unknown }).diagnostics);
}

function severityName(severity: number | undefined): string {
  if (severity === 1) return "Error";
  if (severity === 2) return "Warning";
  if (severity === 3) return "Information";
  if (severity === 4) return "Hint";
  return "Diagnostic";
}

function languageIdForFile(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (/\.(?:c|h)$/i.test(lower)) return "c";
  if (/\.(?:cc|cpp|cxx|hpp|hh|hxx)$/i.test(lower)) return "cpp";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".swift")) return "swift";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".rb")) return "ruby";
  return "plaintext";
}
