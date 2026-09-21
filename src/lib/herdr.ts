import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentSessionRef {
  agent: string;
  kind: string;
  value: string;
}

export interface HerdrAgent {
  name: string | null;
  pane_id: string;
  agent: string | null;
  agent_status: AgentStatus;
  title: string | null;
  display_agent: string | null;
  cwd: string | null;
  foreground_cwd: string | null;
  focused: boolean;
  tab_id: string;
  agent_session?: AgentSessionRef | null;
}

export interface AgentEntry extends HerdrAgent {
  /** Null = local machine, otherwise the remote machine label. */
  machine: string | null;
  /** Unique key for list rendering. */
  key: string;
}

export interface MachineProfile {
  id: string;
  label: string;
}

/** Resolve the herdr binary: explicit preference first, then well-known locations, then PATH. */
export function resolveHerdrBin(preferred?: string): string {
  const pref = (preferred ?? "herdr").trim() || "herdr";
  if (pref.includes("/")) {
    return pref;
  }
  const candidates = [join(homedir(), ".local/bin/herdr"), "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return pref;
}

async function runHerdr(bin: string, args: string[], machine?: string | null): Promise<string> {
  const fullArgs = machine ? ["--machine", machine, ...args] : args;
  const { stdout } = await execFileAsync(bin, fullArgs, { timeout: 30000 });
  return stdout.trim();
}

function parseJson(text: string): unknown {
  if (!text) return null;
  return JSON.parse(text);
}

/** `herdr agent list` prints {"id": ..., "result": {"agents": [...], "type": "agent_list"}} */
export async function listAgents(bin: string, machine?: string | null): Promise<HerdrAgent[]> {
  const out = await runHerdr(bin, ["agent", "list"], machine);
  const parsed = parseJson(out) as {
    result?: { agents?: HerdrAgent[] };
    agents?: HerdrAgent[];
  } | null;
  if (!parsed) return [];
  if (Array.isArray(parsed.agents)) return parsed.agents;
  if (parsed.result && Array.isArray(parsed.result.agents)) return parsed.result.agents;
  return [];
}

/** `herdr machine list --json` prints a bare array (possibly wrapped in {result}). */
export async function listMachines(bin: string): Promise<MachineProfile[]> {
  let out: string;
  try {
    out = await runHerdr(bin, ["machine", "list", "--json"]);
  } catch {
    return [];
  }
  const parsed = parseJson(out) as
    | Array<Record<string, unknown>>
    | { result?: Array<Record<string, unknown>> }
    | null;
  const items = Array.isArray(parsed) ? parsed : parsed?.result ?? [];
  return items.map((item) => {
    const id = String(item["id"] ?? item["profile_id"] ?? item["profileId"] ?? item["label"] ?? "");
    const label = String(item["label"] ?? item["name"] ?? id);
    return { id, label };
  }).filter((m) => m.id.length > 0);
}

export function agentTarget(agent: HerdrAgent): string {
  return agent.name ?? agent.pane_id;
}

export function agentLabel(agent: HerdrAgent): string {
  return agent.display_agent ?? agent.name ?? (agent.agent ? shortAgent(agent.agent) : agent.pane_id);
}

const AGENT_SHORT: Record<string, string> = {
  opencode: "oc",
  claude: "cc",
  codex: "cx",
};

export function shortAgent(agent: string | null | undefined): string {
  if (!agent) return "?";
  return AGENT_SHORT[agent.toLowerCase()] ?? agent;
}

/** Collapse the home directory: ~/projects instead of /home/user/projects. */
export function shortenHome(path: string | null | undefined): string {
  if (!path) return "";
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export async function readAgent(
  bin: string,
  target: string,
  machine?: string | null,
  lines = 60,
): Promise<string> {
  return runHerdr(bin, ["agent", "read", target, "--lines", String(lines)], machine);
}

export async function focusAgent(bin: string, target: string, machine?: string | null): Promise<void> {
  await runHerdr(bin, ["agent", "focus", target], machine);
}

export function statusRank(status: AgentStatus): number {
  switch (status) {
    case "blocked":
      return 0;
    case "done":
      return 1;
    case "working":
      return 2;
    case "idle":
      return 3;
    case "unknown":
      return 4;
  }
}
