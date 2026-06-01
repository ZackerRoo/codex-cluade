import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  inspectCodeDefinition,
  inspectCodeDiagnostics,
  inspectCodeReferences,
  inspectCodeSymbols
} from "../src/code/CodeIntelligence.js";

describe("CodeIntelligence", () => {
  it("extracts TypeScript symbols with source locations", async () => {
    const workspace = await createFixtureWorkspace();

    const result = await inspectCodeSymbols({ workspace, file: "src/user.ts" });

    assert.equal(result.ok, true);
    assert.ok(result.symbols.some(symbol => symbol.kind === "interface" && symbol.name === "User"));
    assert.ok(result.symbols.some(symbol => symbol.kind === "class" && symbol.name === "UserService"));
    assert.ok(result.symbols.some(symbol => symbol.kind === "method" && symbol.name === "getUserProfile"));
    assert.ok(result.symbols.some(symbol => symbol.kind === "function" && symbol.name === "formatUser"));
    assert.ok(result.symbols.every(symbol => symbol.file.endsWith("src/user.ts")));
  });

  it("finds symbol definitions and references through the TypeScript language service", async () => {
    const workspace = await createFixtureWorkspace();

    const definition = await inspectCodeDefinition({
      workspace,
      file: "src/consumer.ts",
      line: 4,
      column: 13
    });
    assert.equal(definition.ok, true);
    assert.ok(definition.definitions.some(item => item.file.endsWith("src/user.ts") && item.text.includes("formatUser")));

    const references = await inspectCodeReferences({
      workspace,
      file: "src/user.ts",
      line: 12,
      column: 17
    });
    assert.equal(references.ok, true);
    assert.ok(references.references.some(item => item.file.endsWith("src/consumer.ts") && item.text.includes("formatUser")));
  });

  it("reports TypeScript diagnostics for a workspace", async () => {
    const workspace = await createFixtureWorkspace();

    const result = await inspectCodeDiagnostics({ workspace });

    assert.equal(result.ok, true);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.file.endsWith("src/broken.ts") && /number/.test(diagnostic.message)));
  });

  it("extracts symbols from common non-TypeScript languages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-code-intel-polyglot-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "service.py"), [
      "class UserService:",
      "    def get_user_profile(self, user):",
      "        return user.name",
      "",
      "def format_user(user):",
      "    return user.name"
    ].join("\n"), "utf8");
    await writeFile(join(workspace, "src", "UserService.java"), [
      "package demo;",
      "public interface Repository {}",
      "public class UserService {",
      "  public String getUserProfile(User user) { return user.name; }",
      "}"
    ].join("\n"), "utf8");
    await writeFile(join(workspace, "src", "service.go"), [
      "package demo",
      "type UserService struct {}",
      "func (s *UserService) GetUserProfile(user User) string { return user.Name }",
      "func FormatUser(user User) string { return user.Name }"
    ].join("\n"), "utf8");
    await writeFile(join(workspace, "src", "service.rs"), [
      "pub struct UserService;",
      "impl UserService {",
      "  pub fn get_user_profile(&self) -> String { String::new() }",
      "}",
      "pub fn format_user() -> String { String::new() }"
    ].join("\n"), "utf8");

    const python = await inspectCodeSymbols({ workspace, file: "src/service.py" });
    assert.ok(python.symbols.some(symbol => symbol.kind === "class" && symbol.name === "UserService"));
    assert.ok(python.symbols.some(symbol => symbol.kind === "function" && symbol.name === "format_user"));

    const java = await inspectCodeSymbols({ workspace, file: "src/UserService.java" });
    assert.ok(java.symbols.some(symbol => symbol.kind === "interface" && symbol.name === "Repository"));
    assert.ok(java.symbols.some(symbol => symbol.kind === "class" && symbol.name === "UserService"));

    const go = await inspectCodeSymbols({ workspace, file: "src/service.go" });
    assert.ok(go.symbols.some(symbol => symbol.kind === "struct" && symbol.name === "UserService"));
    assert.ok(go.symbols.some(symbol => symbol.kind === "function" && symbol.name === "FormatUser"));

    const rust = await inspectCodeSymbols({ workspace, file: "src/service.rs" });
    assert.ok(rust.symbols.some(symbol => symbol.kind === "struct" && symbol.name === "UserService"));
    assert.ok(rust.symbols.some(symbol => symbol.kind === "function" && symbol.name === "format_user"));
  });

  it("uses a language server for non-TypeScript definitions, references, and diagnostics", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-code-intel-lsp-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "service.py"), [
      "def format_user(user):",
      "    return user.name",
      "",
      "print(format_user(object()))"
    ].join("\n"), "utf8");
    const serverPath = join(workspace, "fake-lsp-server.mjs");
    await writeFile(serverPath, fakeLspServerSource(), "utf8");
    await chmod(serverPath, 0o755);
    const lsp = { lspCommand: process.execPath, lspArgs: [serverPath], lspTimeoutMs: 3_000 };

    const definition = await inspectCodeDefinition({
      workspace,
      file: "src/service.py",
      line: 4,
      column: 8,
      ...lsp
    });
    assert.equal(definition.ok, true);
    assert.ok(definition.definitions.some(item => item.file.endsWith("src/service.py") && item.line === 1));

    const references = await inspectCodeReferences({
      workspace,
      file: "src/service.py",
      line: 1,
      column: 5,
      ...lsp
    });
    assert.equal(references.ok, true);
    assert.ok(references.references.some(item => item.file.endsWith("src/service.py") && item.line === 4));

    const diagnostics = await inspectCodeDiagnostics({
      workspace,
      files: ["src/service.py"],
      ...lsp
    });
    assert.equal(diagnostics.ok, true);
    assert.ok(diagnostics.diagnostics.some(item => item.message === "fake diagnostic"));
  });
});

async function createFixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "bridge-code-intel-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true
    },
    include: ["src/**/*.ts"]
  }), "utf8");
  await writeFile(join(workspace, "src", "user.ts"), [
    "export interface User {",
    "  id: string;",
    "  name: string;",
    "}",
    "",
    "export class UserService {",
    "  getUserProfile(user: User): string {",
    "    return user.name;",
    "  }",
    "}",
    "",
    "export function formatUser(user: User): string {",
    "  return user.name;",
    "}"
  ].join("\n"), "utf8");
  await writeFile(join(workspace, "src", "consumer.ts"), [
    "import { formatUser, UserService } from './user.js';",
    "",
    "const service = new UserService();",
    "console.log(formatUser({ id: '1', name: 'Ada' }));",
    "console.log(service.getUserProfile({ id: '2', name: 'Grace' }));"
  ].join("\n"), "utf8");
  await writeFile(join(workspace, "src", "broken.ts"), "const value: number = 'not a number';\n", "utf8");
  return workspace;
}

function fakeLspServerSource(): string {
  return `
let buffer = Buffer.alloc(0);
let openedUri = "";
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const length = Number(header.match(/Content-Length: (\\d+)/i)?.[1] ?? 0);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.slice(start, start + length).toString("utf8"));
    buffer = buffer.slice(start + length);
    handle(message);
  }
});
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true, referencesProvider: true, textDocumentSync: 1 } } });
    return;
  }
  if (message.method === "textDocument/didOpen") {
    openedUri = message.params.textDocument.uri;
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: openedUri, diagnostics: [{
      range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } },
      severity: 1,
      code: "FAKE001",
      message: "fake diagnostic"
    }] } });
    return;
  }
  if (message.method === "textDocument/definition") {
    send({ jsonrpc: "2.0", id: message.id, result: [{ uri: message.params.textDocument.uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 15 } } }] });
    return;
  }
  if (message.method === "textDocument/references") {
    send({ jsonrpc: "2.0", id: message.id, result: [{ uri: message.params.textDocument.uri, range: { start: { line: 3, character: 6 }, end: { line: 3, character: 17 } } }] });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
  }
}
`;
}
