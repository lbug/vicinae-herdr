import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const execFileAsync = promisify(execFile);

export interface SessionCost {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  source: "opencode" | "pi";
  /** Human session title, when the CLI stores one (opencode) or one can be derived (pi: first prompt). */
  title?: string;
  /**
   * Current context size (opencode only): token total of the latest assistant step,
   * which is what `oc` shows in its footer. Cumulative counters above are session totals.
   */
  contextTokens?: number;
}

/** Headline total: input + output, matching what the CLIs themselves report per session. */
export function headlineTokens(cost: SessionCost): number {
  return cost.inputTokens + cost.outputTokens;
}

/** Everything processed, for the detail breakdown. */
export function totalTokens(cost: SessionCost): number {
  return (
    cost.inputTokens +
    cost.outputTokens +
    cost.reasoningTokens +
    cost.cacheReadTokens +
    cost.cacheWriteTokens
  );
}

interface CacheEntry {
  at: number;
  cost: SessionCost | null;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function resolveSqlite3(): string {
  const candidates = [
    join(homedir(), "miniconda3/bin/sqlite3"),
    "/usr/bin/sqlite3",
    "/usr/local/bin/sqlite3",
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return "sqlite3";
}

function opencodeDbPath(): string | null {
  const base = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local/share");
  const db = join(base, "opencode/opencode.db");
  return existsSync(db) ? db : null;
}

async function openCodeCost(sessionId: string): Promise<SessionCost | null> {
  if (!SAFE_ID.test(sessionId)) return null;
  const db = opencodeDbPath();
  if (!db) return null;
  try {
    const sqlite3 = resolveSqlite3();
    const { stdout } = await execFileAsync(sqlite3, [
      db,
      "-separator",
      "\t",
      `SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, title FROM session_v2 WHERE id = '${sessionId}' LIMIT 1;`,
    ]);
    const parts = stdout.trim().split("\t");
    if (parts.length < 3 || !parts[0]) return null;
    const cost: SessionCost = {
      costUsd: Number(parts[0]) || 0,
      inputTokens: Number(parts[1]) || 0,
      outputTokens: Number(parts[2]) || 0,
      reasoningTokens: Number(parts[3]) || 0,
      cacheReadTokens: Number(parts[4]) || 0,
      cacheWriteTokens: Number(parts[5]) || 0,
      source: "opencode",
      title: parts[6]?.trim() || undefined,
    };
    // Current context = latest assistant step total (what `oc` shows in its footer).
    try {
      const { stdout: stepOut } = await execFileAsync(sqlite3, [
        db,
        `SELECT data FROM session_message WHERE session_id = '${sessionId}' AND type = 'assistant' ORDER BY seq DESC LIMIT 1;`,
      ]);
      const step = JSON.parse(stepOut.trim()) as {
        tokens?: {
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number; write?: number };
        };
      };
      const t = step.tokens;
      if (t) {
        cost.contextTokens =
          (t.input ?? 0) +
          (t.output ?? 0) +
          (t.reasoning ?? 0) +
          (t.cache?.read ?? 0) +
          (t.cache?.write ?? 0);
      }
    } catch {
      // fall back to cumulative counters
    }
    return cost;
  } catch {
    return null;
  }
}

async function findPiSessionFile(sessionValue: string): Promise<string | null> {
  if (sessionValue.endsWith(".jsonl") && existsSync(sessionValue)) return sessionValue;
  const root = join(homedir(), ".pi/agent/sessions");
  if (!existsSync(root)) return null;
  const id = sessionValue.includes("/") ? basename(sessionValue, ".jsonl").split("_").pop() ?? sessionValue : sessionValue;
  try {
    const groups = await fs.readdir(root);
    for (const group of groups) {
      const dir = join(root, group);
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      const match = files.find((f) => f === `${id}.jsonl` || f.endsWith(`_${id}.jsonl`));
      if (match) return join(dir, match);
    }
  } catch {
    return null;
  }
  return null;
}

async function piCost(sessionValue: string): Promise<SessionCost | null> {
  const file = await findPiSessionFile(sessionValue);
  if (!file) return null;
  try {
    const stat = await fs.stat(file);
    if (stat.size > 50 * 1024 * 1024) return null;
    const text = await fs.readFile(file, "utf8");
    let cost = 0;
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let found = false;
    let title: string | undefined;
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"') && !line.includes('"role":"user"')) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: {
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
            usage?: {
              input?: number;
              output?: number;
              reasoning?: number;
              cacheRead?: number;
              cacheWrite?: number;
              cost?: { total?: number };
            };
          };
        };
        if (!title && entry.message?.role === "user") {
          const firstText = entry.message.content?.find((c) => c.type === "text" && c.text)?.text;
          if (firstText) title = firstText.trim().split("\n")[0]?.slice(0, 80);
        }
        const usage = entry.message?.usage;
        if (!usage) continue;
        found = true;
        input += usage.input ?? 0;
        output += usage.output ?? 0;
        reasoning += usage.reasoning ?? 0;
        cacheRead += usage.cacheRead ?? 0;
        cacheWrite += usage.cacheWrite ?? 0;
        cost += usage.cost?.total ?? 0;
      } catch {
        // skip malformed lines
      }
    }
    if (!found) return null;
    return {
      costUsd: cost,
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: reasoning,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      source: "pi",
      title,
    };
  } catch {
    return null;
  }
}

/** Cost for one agent session. Results cached 30s. Null = unknown/unsupported. */
export async function getSessionCost(
  agent: string | null | undefined,
  sessionValue: string | null | undefined,
): Promise<SessionCost | null> {
  if (!agent || !sessionValue) return null;
  const normalized = agent.toLowerCase();
  if (normalized !== "opencode" && normalized !== "pi") return null;
  const cacheKey = `${normalized}:${sessionValue}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.cost;

  const cost = normalized === "opencode" ? await openCodeCost(sessionValue) : await piCost(sessionValue);
  cache.set(cacheKey, { at: Date.now(), cost });
  return cost;
}

/** Cost as `oc` shows it: rounded to cents. */
export function formatCost(cost: SessionCost): string {
  return `$${cost.costUsd.toFixed(2)}`;
}

/** Exact cost for the detail view. */
export function formatCostExact(cost: SessionCost): string {
  return cost.costUsd < 0.01 ? `$${cost.costUsd.toFixed(4)}` : formatCost(cost);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
