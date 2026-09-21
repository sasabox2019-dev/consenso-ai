/**
 * D1-compatible shim over node:sqlite (Node ≥22.5).
 * Implements the exact subset of the D1 API the repository uses, so the same
 * route/core code runs on Cloudflare D1 in production and on plain Node in
 * dev/tests. No business logic here.
 */
import { DatabaseSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "../env";

type SQLInputValue = string | number | bigint | Uint8Array | null;

function adaptValue(v: unknown): SQLInputValue {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as SQLInputValue;
}

export class NodeSqliteD1 implements D1Database {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  }

  exec(sql: string): Promise<unknown> {
    this.db.exec(sql);
    return Promise.resolve({ success: true });
  }

  prepare(sql: string): D1PreparedStatement {
    return new NodeStatement(this.db, sql);
  }
}

class NodeStatement implements D1PreparedStatement {
  private db: DatabaseSync;
  private sql: string;
  private params: SQLInputValue[] = [];

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    const stmt = new NodeStatement(this.db, this.sql);
    stmt.params = values.map(adaptValue);
    return stmt;
  }

  first<T = unknown>(_col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as T | undefined;
    return Promise.resolve(row ?? null);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return Promise.resolve({ results: rows, success: true });
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    const info = this.db.prepare(this.sql).run(...this.params);
    return Promise.resolve({
      results: [],
      success: true,
      meta: { changes: Number(info.changes ?? 0) },
    });
  }
}
