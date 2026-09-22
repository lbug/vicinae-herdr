import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findPiSessionFile } from "./cost";
import { withOpenCodeDb } from "./opencode-db";

/**
 * The agent's last message as plain text, read from the agent's own session store —
 * without terminal chrome, reasoning, or tool calls.
 */

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

interface ContentPart {
  type?: string;
  text?: string;
}

/** Joined text parts of one message, skipping reasoning and tool calls. Empty string when there is none. */
function replyText(parts: ContentPart[] | undefined): string {
  return (parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

/** OpenCode stores one row per assistant step; the newest step with text is the last message. */
function openCodeLastResponse(sessionId: string): string | null {
  return withOpenCodeDb((db) => {
    const rows = db
      .prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC")
      .iterate(sessionId) as Iterable<{ data: string }>;
    for (const row of rows) {
      try {
        const text = replyText((JSON.parse(row.data) as { content?: ContentPart[] }).content);
        if (text) return text;
      } catch {
        // skip malformed rows
      }
    }
    return null;
  });
}

async function readJsonLines(file: string): Promise<unknown[]> {
  const stat = await fs.stat(file);
  if (stat.size > MAX_TRANSCRIPT_BYTES) return [];
  const entries: unknown[] = [];
  for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

async function piLastResponse(sessionValue: string): Promise<string | null> {
  const file = await findPiSessionFile(sessionValue);
  if (!file) return null;
  let last: string | null = null;
  for (const entry of (await readJsonLines(file)) as Array<{
    message?: { role?: string; content?: ContentPart[] };
  }>) {
    if (entry.message?.role !== "assistant") continue;
    last = replyText(entry.message.content) || last;
  }
  return last;
}

async function findClaudeSessionFile(sessionId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  const configDir = process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
  const root = join(configDir, "projects");
  if (!existsSync(root)) return null;
  for (const project of await fs.readdir(root)) {
    const candidate = join(root, project, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function claudeLastResponse(sessionId: string): Promise<string | null> {
  const file = await findClaudeSessionFile(sessionId);
  if (!file) return null;
  // Claude Code writes each content block of a message as its own line, sharing message.id.
  let lastId: string | undefined;
  let blocks: string[] = [];
  for (const entry of (await readJsonLines(file)) as Array<{
    type?: string;
    isSidechain?: boolean;
    message?: { id?: string; content?: string | ContentPart[] };
  }>) {
    if (entry.type !== "assistant" || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
    const text = replyText(entry.message.content);
    if (!text) continue;
    if (entry.message.id === undefined || entry.message.id !== lastId) blocks = [];
    lastId = entry.message.id;
    blocks.push(text);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/** Null = agent not supported or no reply recorded yet; callers fall back to terminal output. */
export async function getLastResponse(
  agent: string | null | undefined,
  sessionValue: string | null | undefined,
): Promise<string | null> {
  if (!agent || !sessionValue) return null;
  try {
    switch (agent.toLowerCase()) {
      case "opencode":
        return openCodeLastResponse(sessionValue);
      case "pi":
        return await piLastResponse(sessionValue);
      case "claude":
        return await claudeLastResponse(sessionValue);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// Rows made only of box-drawing, block, and spacing characters: TUI borders, input boxes, scrollbars.
const CHROME_LINE = /^[\s\u2500-\u259F\u2800-\u28FF~]*$/;
// Left gutters like "┃  " or "│ " that TUIs draw in front of message text.
const GUTTER = /^\s*[\u2502\u2503\u2551\u258C\u258E]\s?/;

/** Best-effort cleanup of a raw terminal snapshot for agents without a readable transcript. */
export function cleanTerminalOutput(raw: string): string {
  const lines = raw.split("\n").map((line) => line.replace(GUTTER, "").trimEnd());
  const kept = lines.filter((line) => line === "" || !CHROME_LINE.test(line));
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
