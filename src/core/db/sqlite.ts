import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// node:sqlite ships with Node, so the core needs no compiled addon. Some Node
// releases print an ExperimentalWarning the first time it loads; the CLI filters that
// one warning so it does not clutter command output.

export type Database = DatabaseSync;
export type SqlValue = SQLInputValue;

export function openDatabase(filePath: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(filePath, { readOnly: Boolean(options.readOnly) });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** better-sqlite3's db.transaction() replacement. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error matters more than a failed rollback.
    }
    throw error;
  }
}

/** node:sqlite rejects undefined and booleans as bindings; normalize them. */
export function bindValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

export function bindAll(values: unknown[]): SqlValue[] {
  return values.map(bindValue);
}

export function tableColumns(db: DatabaseSync, table: string): Set<string> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`Invalid table name: ${table}`);
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => String(row.name))
  );
}

export function countRows(db: DatabaseSync, table: string): number {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`Invalid table name: ${table}`);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint } | undefined;
  return Number(row?.count ?? 0);
}

export function integrityOk(db: DatabaseSync): { ok: boolean; detail: string } {
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  const detail = rows.map((row) => String(Object.values(row)[0])).join("; ");
  return { ok: detail === "ok", detail };
}

export function fts5Available(): { ok: boolean; detail: string } {
  try {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE probe USING fts5(text); INSERT INTO probe(text) VALUES ('hello world');");
      const row = db.prepare("SELECT COUNT(*) AS count FROM probe WHERE probe MATCH 'hello'").get() as { count: number };
      return { ok: Number(row.count) === 1, detail: `node:sqlite with FTS5 (SQLite ${sqliteVersion(db)})` };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function sqliteVersion(db: DatabaseSync): string {
  const row = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
  return row.version;
}
