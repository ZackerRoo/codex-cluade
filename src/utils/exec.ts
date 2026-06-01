import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function execFileCapture(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    input?: string;
    signal?: AbortSignal;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);

    const abort = () => {
      child.kill("SIGTERM");
      finish({ code: null, stdout, stderr, timedOut: false });
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      options.onStdoutChunk?.(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
      options.onStderrChunk?.(chunk);
    });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", code => {
      finish({ code, stdout, stderr, timedOut: false });
    });

    child.stdin.end(options.input ?? "");
  });
}

export function execShellCapture(
  command: string,
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }
): Promise<ExecResult> {
  return execFileCapture("/bin/sh", ["-lc", command], options);
}
