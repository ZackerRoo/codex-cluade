import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Stage } from "../types.js";

export class ResultStore {
  constructor(private readonly workspace: string) {}

  runDir(runId: string): string {
    return join(this.workspace, ".agent-runs", runId);
  }

  async ensureRunDir(runId: string): Promise<string> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async writeStageInput(runId: string, stage: Stage, content: string): Promise<string> {
    const dir = await this.ensureRunDir(runId);
    const path = join(dir, `${stage}.input.md`);
    await writeFile(path, content, "utf8");
    return path;
  }

  async writeStageOutput(runId: string, stage: Stage, content: string): Promise<string> {
    const dir = await this.ensureRunDir(runId);
    const path = join(dir, `${stage}.output.md`);
    await writeFile(path, content, "utf8");
    return path;
  }

  async writeLog(runId: string, name: string, content: string): Promise<string> {
    const dir = await this.ensureRunDir(runId);
    const path = join(dir, name);
    await writeFile(path, content, "utf8");
    return path;
  }
}
