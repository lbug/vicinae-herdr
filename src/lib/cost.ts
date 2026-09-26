import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { withOpenCodeDb } from "./opencode-db";

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
   * which is what OpenCode shows in its footer. Cumulative counters above are session totals.
   */
  contextTokens?: number;
}

/** Headline total: input + output, matching what the CLIs themselves report per session. */
export function headlineTokens(cost: SessionCost): number {
  return cost.inputTokens + cost.outputTokens;
}

interface CacheEntry {
  at: number;
  cost: SessionCost | null;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

interface OpenCodeSessionRow {
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  title: string | null;
}

interface OpenCodeStep {
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

function openCodeCost(sessionId: string): SessionCost | null {
  return withOpenCodeDb((db) => {
    const row = db
      .prepare(
        "SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, title FROM session_v2 WHERE id = ? LIMIT 1",
      )
      .get(sessionId) as OpenCodeSessionRow | undefined;
    if (!row) return null;
    const cost: SessionCost = {
      costUsd: row.cost ?? 0,
      inputTokens: row.tokens_input ?? 0,
      outputTokens: row.tokens_output ?? 0,
      reasoningTokens: row.tokens_reasoning ?? 0,
      cacheReadTokens: row.tokens_cache_read ?? 0,
      cacheWriteTokens: row.tokens_cache_write ?? 0,
      source: "opencode",
      title: row.title?.trim() || undefined,
    };
    // Current context = token total of the latest assistant step (what OpenCode shows in its footer).
    try {
      const step = db
        .prepare(
          "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1",
        )
        .get(sessionId) as { data?: string } | undefined;
      const t = step?.data ? (JSON.parse(step.data) as OpenCodeStep).tokens : undefined;
      if (t) {
        cost.contextTokens =
          (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
      }
    } catch {
      // fall back to cumulative counters
    }
    return cost;
  });
}

export async function findPiSessionFile(sessionValue: string): Promise<string | null> {
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

  const cost = normalized === "opencode" ? openCodeCost(sessionValue) : await piCost(sessionValue);
  cache.set(cacheKey, { at: Date.now(), cost });
  return cost;
}

/** Cost as OpenCode shows it: rounded to cents. */
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
