/**
 * Minimal D1-compatible interface + Worker environment.
 * The API surface is intentionally the small subset we use, so the exact same
 * repository code runs against real Cloudflare D1 in production and against a
 * node:sqlite-backed shim in local dev and tests.
 */

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: { changes?: number; duration?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec?(query: string): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  /** Static assets binding (Cloudflare). The Node dev server provides an equivalent. */
  ASSETS: { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
  /** Base64/hex master key — encrypts provider API keys at rest. */
  MASTER_KEY?: string;
  /** HMAC secret for session JWTs and the password pepper. */
  JWT_SECRET?: string;
  /** When set, admin bootstrap additionally requires this token. */
  BOOTSTRAP_TOKEN?: string;
  /** Test/dev injection point for the upstream LLM transport. */
  LLM_FETCHER?: typeof fetch;
  SEED_DEMO?: string;
}

export function clientIp(req: Request): string {
  // Only Cloudflare's injected header is trustworthy; X-Forwarded-For is
  // client-controlled and would let anyone rotate their rate-limit bucket.
  // Without it (local dev, non-CF deployments) every client shares one bucket.
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}
