/**
 * Session tokens: compact JWTs (HS256) signed with JWT_SECRET, delivered as
 * HttpOnly + SameSite=Strict + Secure cookies (no token in localStorage, no
 * CSRF exposure from cookie auto-send since SameSite=Strict).
 */
import { SESSION_COOKIE, SESSION_TTL_S } from "@consenso/shared";
import { constantTimeEqual, fromBase64, hmacHex, toBase64 } from "./crypto";

interface JwtPayload {
  sub: string;
  /** Session version — server bumps it to revoke outstanding tokens (logout). */
  ver?: number;
  iat: number;
  exp: number;
}

function jsonB64(obj: unknown): string {
  return toBase64(new TextEncoder().encode(JSON.stringify(obj)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64Json<T>(s: string): T | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(fromBase64(padded));
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export async function signSession(
  secret: string,
  username: string,
  version = 1,
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_S;
  const header = jsonB64({ alg: "HS256", typ: "JWT" });
  const payload = jsonB64({
    sub: username,
    ver: version,
    iat: now,
    exp: expiresAt,
  } satisfies JwtPayload);
  const sig = await hmacHex(secret, `${header}.${payload}`);
  const token = `${header}.${payload}.${sig}`;
  return { token, expiresAt };
}

/** Returns the username when valid, current (not revoked) and unexpired. */
export async function verifySession(
  secret: string,
  token: string,
  expectedVersion?: number,
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const [header, payload, sig] = parts;
  const expected = await hmacHex(secret, `${header}.${payload}`);
  if (!constantTimeEqual(sig, expected)) return null;
  const decoded = b64Json<JwtPayload>(payload);
  if (!decoded || typeof decoded.sub !== "string") return null;
  if (typeof decoded.exp !== "number" || decoded.exp < Math.floor(Date.now() / 1000)) return null;
  if (expectedVersion !== undefined && decoded.ver !== expectedVersion) return null;
  return decoded.sub;
}

export function sessionCookie(token: string, expiresAt: number): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Expires=${new Date(expiresAt * 1000).toUTCString()}`,
  ];
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function extractSessionToken(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const pair of cookie.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}
