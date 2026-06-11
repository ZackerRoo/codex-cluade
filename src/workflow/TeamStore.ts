import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentName, AgentTeam, TeamMember, TeamMessage, TeamTask, TeamTaskStatus } from "../types.js";

export interface TeamStoreOptions {
  rootDir?: string;
}

export interface CreateTeamInput {
  id?: string;
  workspace: string;
  goal: string;
  lead?: string;
  members?: Array<{
    id?: string;
    role: string;
    profile?: string;
    agent?: AgentName;
    summary?: string;
  }>;
}

export class TeamStore {
  private readonly rootDir: string;

  constructor(options: TeamStoreOptions = {}) {
    this.rootDir = options.rootDir ?? process.env.CODEX_CLAUDE_TEAM_STORE ?? join(homedir(), ".codex-claude", "teams");
  }

  create(input: CreateTeamInput): AgentTeam {
    const now = new Date().toISOString();
    const id = input.id ?? createTeamId();
    const team: AgentTeam = {
      id,
      workspace: input.workspace,
      goal: input.goal,
      lead: input.lead ?? "lead",
      members: (input.members ?? []).map((member, index): TeamMember => ({
        id: member.id ?? safeId(member.role || `member-${index + 1}`),
        role: member.role,
        profile: member.profile,
        agent: member.agent,
        summary: member.summary,
        status: "active",
        createdAt: now,
        updatedAt: now
      })),
      messages: [],
      tasks: [],
      createdAt: now,
      updatedAt: now
    };
    this.save(team);
    return team;
  }

  get(teamId: string): AgentTeam | undefined {
    const path = this.pathFor(teamId);
    if (!existsSync(path)) return undefined;
    return parseTeam(readFileSync(path, "utf8"));
  }

  list(): AgentTeam[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir)
      .filter(file => file.endsWith(".json"))
      .map(file => parseTeam(readFileSync(join(this.rootDir, file), "utf8")))
      .filter((team): team is AgentTeam => team !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  sendMessage(input: { teamId: string; from: string; to?: string; body: string; taskId?: string }): TeamMessage | undefined {
    const team = this.get(input.teamId);
    if (!team) return undefined;
    const now = new Date().toISOString();
    const message: TeamMessage = {
      id: `${team.id}-msg-${team.messages.length + 1}`,
      teamId: team.id,
      from: input.from,
      to: input.to ?? "all",
      body: input.body,
      taskId: input.taskId,
      createdAt: now
    };
    team.messages.push(message);
    team.updatedAt = now;
    this.save(team);
    return message;
  }

  inbox(teamId: string, memberId: string): TeamMessage[] | undefined {
    const team = this.get(teamId);
    if (!team) return undefined;
    return team.messages.filter(message => message.to === "all" || message.to === memberId || message.from === memberId);
  }

  createTask(input: { teamId: string; title: string; description?: string; assignee?: string; linkedTaskId?: string }): TeamTask | undefined {
    const team = this.get(input.teamId);
    if (!team) return undefined;
    const now = new Date().toISOString();
    const task: TeamTask = {
      id: `${team.id}-task-${team.tasks.length + 1}`,
      teamId: team.id,
      title: input.title,
      description: input.description ?? "",
      assignee: input.assignee,
      status: "todo",
      linkedTaskId: input.linkedTaskId,
      createdAt: now,
      updatedAt: now
    };
    team.tasks.push(task);
    team.updatedAt = now;
    this.save(team);
    return task;
  }

  updateTask(input: { teamId: string; taskId: string; status?: TeamTaskStatus; assignee?: string; linkedTaskId?: string; description?: string }): TeamTask | undefined {
    const team = this.get(input.teamId);
    if (!team) return undefined;
    const task = team.tasks.find(item => item.id === input.taskId);
    if (!task) return undefined;
    const now = new Date().toISOString();
    if (input.status) task.status = input.status;
    if (input.assignee !== undefined) task.assignee = input.assignee;
    if (input.linkedTaskId !== undefined) task.linkedTaskId = input.linkedTaskId;
    if (input.description !== undefined) task.description = input.description;
    task.updatedAt = now;
    team.updatedAt = now;
    this.save(team);
    return task;
  }

  save(team: AgentTeam): void {
    mkdirSync(this.rootDir, { recursive: true });
    const path = this.pathFor(team.id);
    const tempPath = `${path}.tmp-${process.pid}`;
    writeFileSync(tempPath, `${JSON.stringify(team, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  }

  private pathFor(teamId: string): string {
    return join(this.rootDir, `${safeId(teamId)}.json`);
  }
}

function createTeamId(): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `team-${stamp}-${suffix}`;
}

function parseTeam(content: string): AgentTeam | undefined {
  try {
    const parsed = JSON.parse(content) as AgentTeam;
    if (typeof parsed.id !== "string" || typeof parsed.workspace !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function safeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "member";
}
