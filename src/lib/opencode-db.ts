import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type SqliteModule = typeof import("node:sqlite");
export type OpenCodeDb = InstanceType<SqliteModule["DatabaseSync"]>;

let sqliteModule: SqliteModule | null | undefined;

/** node:sqlite ships with Node >= 22.13; on older runtimes OpenCode data is simply unavailable. */
function loadSqlite(): SqliteModule | null {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = require("node:sqlite") as SqliteModule;
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

function opencodeDbPath(): string | null {
  const base = process.env["XDG_DATA_HOME"] || join(homedir(), ".local/share");
  const db = join(base, "opencode/opencode.db");
  return existsSync(db) ? db : null;
}

/** Run `fn` against a read-only handle to OpenCode's database. Null when unavailable or on any error. */
export function withOpenCodeDb<T>(fn: (db: OpenCodeDb) => T | null): T | null {
  const sqlite = loadSqlite();
  const path = opencodeDbPath();
  if (!sqlite || !path) return null;
  let db: OpenCodeDb | undefined;
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
