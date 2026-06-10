import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import vm from "node:vm";

export interface WebAppExpectation {
  selector: string;
  minCount: number;
}

export interface WebAppVerificationInput {
  workspace: string;
  entry?: string;
  expectations?: WebAppExpectation[];
  minBodyTextLength?: number;
}

export interface WebAppVerificationResult {
  ok: boolean;
  entryPath: string;
  scripts: string[];
  checks: Array<{ selector: string; count: number; minCount: number; ok: boolean }>;
  bodyTextLength: number;
  failures: string[];
  errors: string[];
}

export async function verifyWebApp(input: WebAppVerificationInput): Promise<WebAppVerificationResult> {
  const entry = input.entry ?? "index.html";
  const entryPath = resolve(input.workspace, entry);
  const html = await readFile(entryPath, "utf8");
  const document = FakeDocument.fromHtml(html);
  const errors: string[] = [];
  const scripts = scriptSources(html);

  const context = vm.createContext({
    document,
    window: undefined as unknown,
    localStorage: new MemoryStorage(),
    console,
    Math,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    RegExp,
    Error,
    TypeError,
    setTimeout,
    clearTimeout
  });
  Object.assign(context, { window: context, globalThis: context, self: context });

  for (const script of scripts) {
    try {
      const scriptPath = resolve(input.workspace, script);
      const source = await readFile(scriptPath, "utf8");
      vm.runInContext(source, context, { filename: scriptPath, timeout: 5_000 });
    } catch (error) {
      errors.push(`${script}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  document.readyState = "interactive";
  document.dispatchEvent("DOMContentLoaded");
  document.readyState = "complete";
  document.dispatchEvent("load");

  const expectations = input.expectations ?? [];
  const checks = expectations.map(expectation => {
    const count = document.querySelectorAll(expectation.selector).length;
    return {
      selector: expectation.selector,
      count,
      minCount: expectation.minCount,
      ok: count >= expectation.minCount
    };
  });
  const bodyTextLength = document.body.innerText.trim().length;
  const failures = [
    ...checks.filter(check => !check.ok).map(check => `${check.selector} matched ${check.count}, expected at least ${check.minCount}`),
    input.minBodyTextLength !== undefined && bodyTextLength < input.minBodyTextLength
      ? `body text length ${bodyTextLength}, expected at least ${input.minBodyTextLength}`
      : ""
  ].filter(Boolean);

  return {
    ok: errors.length === 0 && failures.length === 0,
    entryPath,
    scripts,
    checks,
    bodyTextLength,
    failures,
    errors
  };
}

function scriptSources(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map(match => match[1])
    .filter(source => source && !/^[a-z]+:/i.test(source));
}

class MemoryStorage {
  private readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.has(key) ? this.items.get(key) ?? null : null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }
}

class FakeDocument {
  readonly body = new FakeElement("body");
  readyState: "loading" | "interactive" | "complete" = "loading";
  private readonly ids = new Map<string, FakeElement>();
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  static fromHtml(html: string): FakeDocument {
    const document = new FakeDocument();
    document.body.textContent = stripTags(html);
    for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid=["']([^"']+)["'][^>]*>/gi)) {
      const element = new FakeElement(match[1].toLowerCase());
      element.id = match[2];
      element.ownerDocument = document;
      document.ids.set(element.id, element);
      document.body.appendChild(element);
    }
    return document;
  }

  createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName.toLowerCase());
    element.ownerDocument = this;
    return element;
  }

  getElementById(id: string): FakeElement | null {
    return this.ids.get(id) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return querySelectorAll(this.body, selector, this.ids);
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }
}

class FakeElement {
  id = "";
  className = "";
  textContent = "";
  innerHTML = "";
  disabled = false;
  ownerDocument?: FakeDocument;
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(readonly tagName: string) {}

  get childNodes(): FakeElement[] {
    return this.children;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get innerText(): string {
    return [this.textContent, ...this.children.map(child => child.innerText)].filter(Boolean).join(" ");
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length);
    for (const child of children) this.appendChild(child);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
  }

  getAttribute(name: string): string | null {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  querySelector(selector: string): FakeElement | null {
    return querySelectorAll(this, selector, new Map())[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return querySelectorAll(this, selector, new Map());
  }
}

function querySelectorAll(root: FakeElement, selector: string, ids: Map<string, FakeElement>): FakeElement[] {
  const trimmed = selector.trim();
  const directChild = trimmed.match(/^#([A-Za-z0-9_-]+)\s*>\s*\*$/);
  if (directChild) return ids.get(directChild[1])?.children ?? [];

  const descendantTag = trimmed.match(/^#([A-Za-z0-9_-]+)\s+([A-Za-z][A-Za-z0-9-]*)$/);
  if (descendantTag) return descendants(ids.get(descendantTag[1])).filter(element => element.tagName === descendantTag[2].toLowerCase());

  const idOnly = trimmed.match(/^#([A-Za-z0-9_-]+)$/);
  if (idOnly) {
    const element = ids.get(idOnly[1]);
    return element ? [element] : [];
  }

  const tagOnly = trimmed.match(/^[A-Za-z][A-Za-z0-9-]*$/);
  if (tagOnly) return descendants(root).filter(element => element.tagName === trimmed.toLowerCase());

  return [];
}

function descendants(root?: FakeElement): FakeElement[] {
  if (!root) return [];
  const result: FakeElement[] = [];
  const visit = (element: FakeElement) => {
    for (const child of element.children) {
      result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildDefaultWebExpectations(request: string): WebAppExpectation[] {
  if (!/game|游戏|webgame|网页游戏/i.test(request)) return [];
  return [
    { selector: "#map > *", minCount: 1 },
    { selector: "#action-grid button", minCount: 1 }
  ];
}

export function isWebLikeRequest(request: string): boolean {
  return /html|web|网页|browser|game|游戏|前端|页面/i.test(request);
}

export function buildWebVerifyCommand(options: { workspace: string; request: string; cliPath: string }): string | undefined {
  if (!isWebLikeRequest(options.request)) return undefined;
  const expectations = buildDefaultWebExpectations(options.request);
  const args = [
    shellQuote(options.cliPath),
    "verify-web",
    "--workspace",
    shellQuote(options.workspace),
    "--min-body-text",
    "1",
    ...expectations.flatMap(expectation => ["--expect", shellQuote(`${expectation.selector}>=${expectation.minCount}`)])
  ];
  return `node ${args.join(" ")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
