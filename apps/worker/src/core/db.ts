import type { AgentRole } from "@consenso/shared";
/**
 * Data access layer. Every function takes the D1-compatible database handle,
 * so the same code runs on Cloudflare D1 and on the local node:sqlite shim.
 */
import type { D1Database } from "../env";

export interface AgentRow {
  key: string;
  name: string;
  display_name: string;
  url: string;
  model: string;
  api_key_ciphertext: string | null;
  timeout_s: number;
  role: AgentRole;
  active: number;
}

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

export async function listAgents(db: D1Database, activeOnly = false): Promise<AgentRow[]> {
  const sql = activeOnly
    ? "SELECT key, name, display_name, url, model, api_key_ciphertext, timeout_s, role, active FROM agents WHERE active = 1 ORDER BY role, key"
    : "SELECT key, name, display_name, url, model, api_key_ciphertext, timeout_s, role, active FROM agents ORDER BY role, key";
  const res = await db.prepare(sql).all<AgentRow>();
  return res.results ?? [];
}

export async function getAgent(db: D1Database, key: string): Promise<AgentRow | null> {
  return db
    .prepare(
      "SELECT key, name, display_name, url, model, api_key_ciphertext, timeout_s, role, active FROM agents WHERE key = ?",
    )
    .bind(key)
    .first<AgentRow>();
}

export async function agentExists(db: D1Database, key: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS one FROM agents WHERE key = ?").bind(key).first();
  return row !== null;
}

export async function moderatorCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM agents WHERE role = 'moderator' AND active = 1")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createAgent(
  db: D1Database,
  agent: {
    key: string;
    name: string;
    display_name: string;
    url: string;
    model: string;
    api_key_ciphertext: string | null;
    timeout_s: number;
    role: AgentRole;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agents (key, name, display_name, url, model, api_key_ciphertext, timeout_s, role, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      agent.key,
      agent.name,
      agent.display_name,
      agent.url,
      agent.model,
      agent.api_key_ciphertext,
      agent.timeout_s,
      agent.role,
    )
    .run();
}

export async function updateAgentFields(
  db: D1Database,
  key: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const sets = entries.map(([col]) => `${col} = ?`).join(", ");
  await db
    .prepare(
      `UPDATE agents SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key = ?`,
    )
    .bind(...entries.map(([, v]) => v), key)
    .run();
}

export async function deleteAgent(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM agents WHERE key = ?").bind(key).run();
}

// ---------------------------------------------------------------------------
// Admin user (single row, id = 1)
// ---------------------------------------------------------------------------

export async function getAdmin(db: D1Database): Promise<AdminRow | null> {
  return db
    .prepare("SELECT id, username, password_hash FROM admin_user WHERE id = 1")
    .first<AdminRow>();
}

/**
 * Creates the admin account atomically. Returns false when an admin already
 * exists — this closes the bootstrap race where two clients both pass the
 * getAdmin() null-check and the last writer would own the account.
 */
export async function setAdmin(
  db: D1Database,
  username: string,
  passwordHash: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO admin_user (id, username, password_hash) VALUES (1, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(username, passwordHash)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Rotates the existing admin's credentials (bootstrap uses setAdmin instead). */
export async function updateAdminPassword(
  db: D1Database,
  username: string,
  passwordHash: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE admin_user SET username = ?, password_hash = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`,
    )
    .bind(username, passwordHash)
    .run();
}

// ---------------------------------------------------------------------------
// Settings (key/value) — used for session revocation version
// ---------------------------------------------------------------------------

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** Current session version: bumping it invalidates every outstanding token. */
export async function getSessionVersion(db: D1Database): Promise<number> {
  const v = await getSetting(db, "session_ver");
  return v === null ? 1 : Number(v) || 1;
}

export async function bumpSessionVersion(db: D1Database): Promise<number> {
  // Atomic increment: concurrent logouts can't lose a revocation. MAX guards
  // against a corrupted non-numeric stored value resetting the version to 1.
  const row = await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('session_ver', '2')
       ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(settings.value AS INTEGER), 1) + 1
       RETURNING value`,
    )
    .first<{ value: string }>();
  return Number(row?.value ?? 2);
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  target: string | null = null,
  detail: string | null = null,
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES (?, ?, ?, ?)")
    .bind(actor, action, target, detail?.slice(0, 500) ?? null)
    .run();
  // Opportunistic retention (~1% of writes): keep roughly the last 90 days.
  if (Math.random() < 0.01) {
    await db
      .prepare("DELETE FROM audit_log WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')")
      .run();
  }
}

export async function recentAudit(db: D1Database, limit = 100): Promise<AuditRow[]> {
  const res = await db
    .prepare("SELECT id, ts, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<AuditRow>();
  return res.results ?? [];
}

// ---------------------------------------------------------------------------
// Rate limiting — atomic fixed-window counter (upsert + RETURNING)
// with an in-isolate shield in front of D1.
//
// The shield exists because every limiter call is itself a D1 WRITE: a flood
// would otherwise exhaust the free tier's 100k writes/day through the very
// guard meant to protect the API. Once a bucket has visibly hit its cap in
// this isolate, further requests are rejected locally without touching D1.
// Isolate-local state may lag the authoritative D1 count across isolates —
// acceptable for a best-effort shield (D1 remains the source of truth).
// ---------------------------------------------------------------------------

const shield = new Map<string, number>();
const SHIELD_MAX_ENTRIES = 5000;

/** Test hook: each test expects a fresh D1, so the isolate shield must reset too. */
export function resetRateLimitShieldForTests(): void {
  shield.clear();
}

export interface RateVerdict {
  allowed: boolean;
  count: number;
}

export async function rateLimit(
  db: D1Database,
  bucket: string,
  max: number,
  windowS: number,
): Promise<RateVerdict> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowS) * windowS;
  const shieldKey = `${bucket}|${windowStart}`;
  const localCount = shield.get(shieldKey) ?? 0;

  // Cheap rejection: this isolate has already seen this bucket hit its cap.
  if (localCount >= max) {
    return { allowed: false, count: localCount + 1 };
  }

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start
                      THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  shield.set(shieldKey, count);
  if (shield.size > SHIELD_MAX_ENTRIES) {
    // Drop the oldest entries (insertion order) to stay bounded.
    for (const key of shield.keys()) {
      shield.delete(key);
      if (shield.size <= SHIELD_MAX_ENTRIES) break;
    }
  }

  // Opportunistic housekeeping (~1% of calls).
  if (Math.random() < 0.01) {
    await db
      .prepare("DELETE FROM rate_limits WHERE window_start < ?")
      .bind(now - 86_400)
      .run();
  }
  return { allowed: count <= max, count };
}
