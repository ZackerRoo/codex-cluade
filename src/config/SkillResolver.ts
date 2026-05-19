import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { BridgeConfig } from "./BridgeConfig.js";
import type { InjectedSkill } from "../types.js";

export async function resolveSkills(names: string[] | undefined, config: BridgeConfig, cwd = process.cwd()): Promise<InjectedSkill[]> {
  const result: InjectedSkill[] = [];
  for (const name of names ?? []) {
    const skill = config.skills?.[name];
    if (!skill) throw new Error(`Skill not found: ${name}`);
    if (typeof skill.content === "string") {
      result.push({ name, content: skill.content });
      continue;
    }
    if (typeof skill.path === "string") {
      const path = isAbsolute(skill.path) ? skill.path : resolve(cwd, skill.path);
      result.push({ name, content: await readFile(path, "utf8") });
      continue;
    }
    throw new Error(`Skill has no content or path: ${name}`);
  }
  return result;
}
