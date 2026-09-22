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
  terminal_title_stripped?: string | null;
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

/** Resolve the herdr binary: explicit path first, then the installer's default location, then PATH. */
export function resolveHerdrBin(preferred?: string): string {
  const pref = (preferred ?? "herdr").trim() || "herdr";
  if (pref.includes("/")) {
    return pref.startsWith("~/") ? join(homedir(), pref.slice(2)) : pref;
  }
  const candidates = [join(homedir(), ".local/bin/herdr"), "/usr/local/bin/herdr"];
  return candidates.find((candidate) => existsSync(candidate)) ?? pref;
}

/** Turn a failed herdr invocation into a message the user can act on. */
export function describeHerdrError(error: unknown, bin: string): string {
  const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
  if (err?.code === "ENOENT") {
    return `herdr binary not found (${bin}). Install herdr or set its path in the extension preferences.`;
  }
  if (err?.killed) return "herdr did not respond in time.";
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
  if (stderr) return stderr.split("\n")[0] ?? stderr;
  return error instanceof Error ? error.message : String(error);
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

export interface AgentSnapshot {
  entries: AgentEntry[];
  /** Remote machines whose agent list could not be fetched. */
  unreachableMachines: string[];
}

/**
 * Local agents plus every configured remote machine, sorted by urgency.
 * Throws when the local herdr server cannot be queried; remote failures are reported, not thrown.
 */
export async function collectAgents(bin: string): Promise<AgentSnapshot> {
  const machines = await listMachines(bin);
  const [local, ...remote] = await Promise.allSettled([
    listAgents(bin, null),
    ...machines.map((m) => listAgents(bin, m.label)),
  ]);
  if (local.status === "rejected") throw local.reason;

  const entries: AgentEntry[] = [];
  const unreachableMachines: string[] = [];
  const add = (agents: HerdrAgent[], machine: string | null) => {
    for (const agent of agents) {
      entries.push({ ...agent, machine, key: `${machine ?? "local"}:${agent.pane_id}:${agent.name ?? ""}` });
    }
  };
  add(local.value, null);
  remote.forEach((result, index) => {
    const label = machines[index]?.label ?? "?";
    if (result.status === "fulfilled") add(result.value, label);
    else unreachableMachines.push(label);
  });
  entries.sort((a, b) => statusRank(a.agent_status) - statusRank(b.agent_status));
  return { entries, unreachableMachines };
}

/**
 * Session title from herdr, else the terminal title the agent sets. Terminal titles carry agent
 * decoration ("OC | …", "π - …", spinner glyphs) that is stripped; bare agent names are ignored.
 */
export function agentTitle(agent: HerdrAgent): string | null {
  if (agent.title) return agent.title;
  const raw = (agent.terminal_title_stripped ?? "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/^\S{1,4}\s+[|\-–·:]\s+/, "")
    .trim();
  if (!raw || /^(claude code|claude|opencode|codex|pi)$/i.test(raw)) return null;
  // Some agents (pi) put just the directory name in the title; the cwd is shown anyway.
  const cwd = agent.foreground_cwd ?? agent.cwd;
  if (cwd && raw === cwd.split("/").pop()) return null;
  return raw;
}

/** Display names for every agent kind herdr supports (`herdr agent start --kind`). */
const AGENT_NAMES: Record<string, string> = {
  opencode: "OpenCode",
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot CLI",
  cursor: "Cursor Agent",
  cline: "Cline",
  qwen: "Qwen Code",
  kimi: "Kimi CLI",
  pi: "Pi",
  amp: "Amp",
  kiro: "Kiro",
  droid: "Droid",
  grok: "Grok CLI",
  devin: "Devin",
  letta: "Letta Code",
  kilo: "Kilo Code",
  qodercli: "Qoder CLI",
  mastracode: "Mastra Code",
  hermes: "Hermes Agent",
  agy: "agy",
  omp: "omp",
  maki: "maki",
  muse: "muse",
};

export function agentDisplayName(agent: string | null | undefined): string {
  if (!agent) return "Unknown agent";
  return AGENT_NAMES[agent.toLowerCase()] ?? agent;
}

/** Bundled logo or monogram (assets/agent-<kind>.svg); null for kinds herdr added after this release. */
export function agentIconAsset(agent: string | null | undefined): string | null {
  const kind = agent?.toLowerCase();
  return kind && kind in AGENT_NAMES ? `agent-${kind}.svg` : null;
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
