/**
 * Cryptography helpers — Web standard only (works on Workers and Node ≥18).
 *
 * - Provider API keys: AES-256-GCM, random 96-bit IV, key derived from MASTER_KEY.
 *   Stored as "base64(iv).base64(ciphertext+tag)".
 * - Admin password: keyed HMAC-SHA256 ("peppered" hash). A slow KDF (PBKDF2 with
 *   600k iterations) would exceed the Workers free tier 10 ms CPU cap, so we use
 *   a keyed hash instead: the pepper is a server-side secret, so a database leak
 *   alone is not enough to mount an offline brute force. Compensated by strict
 *   login rate limiting and a long generated password at bootstrap.
 */

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export function generatePassword(length = 20): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join("");
}

type SubtleKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function hmacKey(secret: string): Promise<SubtleKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

/** Constant-time string comparison (both hex strings of equal expectation). */
export function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// AES-GCM string encryption (provider API keys at rest)
// ---------------------------------------------------------------------------

async function aesKeyFromMaster(masterKey: string): Promise<SubtleKey> {
  // Reject weak master keys early: a short/passphrase-style MASTER_KEY would
  // make the stored ciphertexts offline-brute-forceable after a DB leak.
  if (masterKey.length < 32) {
    throw new Error(
      "MASTER_KEY too weak: use at least 32 characters (e.g. `openssl rand -hex 32`)",
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(masterKey));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptString(masterKey: string, plaintext: string): Promise<string> {
  const key = await aesKeyFromMaster(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

export async function decryptString(masterKey: string, payload: string): Promise<string> {
  const [ivB64, ctB64] = payload.split(".");
  if (!ivB64 || !ctB64) throw new Error("malformed ciphertext payload");
  const key = await aesKeyFromMaster(masterKey);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64) },
    key,
    fromBase64(ctB64),
  );
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------------------------
// Admin password hashing
// ---------------------------------------------------------------------------

/**
 * Pepper derived via HKDF from JWT_SECRET with a dedicated info label, so the
 * pepper is independent from the session-signing use of the same secret.
 */
async function passwordPepper(jwtSecret: string): Promise<string> {
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(jwtSecret), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("consenso-ai:v2"),
      info: encoder.encode("password-pepper"),
    },
    baseKey,
    256,
  );
  return toHex(new Uint8Array(bits));
}

/** Legacy v1 pepper — kept ONLY to migrate pre-HKDF hashes on login. */
async function legacyPasswordPepper(jwtSecret: string): Promise<string> {
  return hmacHex(jwtSecret, "consenso-password-pepper:v1");
}

export async function hashPassword(
  jwtSecret: string,
  username: string,
  password: string,
): Promise<string> {
  const pepper = await passwordPepper(jwtSecret);
  return hmacHex(pepper, `admin:${username}:${password}`);
}

/**
 * Verifies against the current HKDF pepper, falling back to the legacy v1
 * pepper so accounts hashed before the migration can still log in.
 * `needsRehash` tells the caller to transparently upgrade the stored hash.
 */
export async function verifyPassword(
  jwtSecret: string,
  username: string,
  password: string,
  storedHash: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const candidate = await hashPassword(jwtSecret, username, password);
  if (constantTimeEqual(candidate, storedHash)) return { ok: true, needsRehash: false };
  const legacyCandidate = await hmacHex(
    await legacyPasswordPepper(jwtSecret),
    `admin:${username}:${password}`,
  );
  if (constantTimeEqual(legacyCandidate, storedHash)) return { ok: true, needsRehash: true };
  return { ok: false, needsRehash: false };
}
