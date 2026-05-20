import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface PlanRecord {
  planId: string;
  planPath: string;
  content: string;
}

export class PlanStore {
  constructor(private readonly workspace: string) {}

  planDir(): string {
    return join(this.workspace, ".codex-claude", "plans");
  }

  planPath(planId: string): string {
    return join(this.planDir(), `${safePlanId(planId)}.md`);
  }

  async write(planId: string, content: string): Promise<PlanRecord> {
    await mkdir(this.planDir(), { recursive: true });
    const planPath = this.planPath(planId);
    await writeFile(planPath, content, "utf8");
    return { planId, planPath, content };
  }

  async read(input: { planId?: string; planPath?: string }): Promise<PlanRecord> {
    const planPath = input.planPath
      ? (isAbsolute(input.planPath) ? input.planPath : resolve(this.workspace, input.planPath))
      : input.planId
        ? this.planPath(input.planId)
        : undefined;
    if (!planPath) throw new Error("planId or planPath is required");
    const content = await readFile(planPath, "utf8");
    return {
      planId: input.planId ?? basename(planPath, ".md"),
      planPath,
      content
    };
  }
}

export function createPlanId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${date}-${suffix}`;
}

function safePlanId(planId: string): string {
  return planId.replace(/[^a-zA-Z0-9._-]/g, "_");
}
