import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  decryptString,
  encryptString,
  generatePassword,
  hashPassword,
  hmacHex,
  verifyPassword,
} from "../src/core/crypto";

describe("crypto", () => {
  it("round-trips AES-GCM encryption", async () => {
    const master = "test-master-key-0123456789abcdef0123456789abcdef";
    const secret = "gsk_live_abc123-Ünïcode-ok";
    const ct = await encryptString(master, secret);
    expect(ct).not.toContain(secret);
    expect(await decryptString(master, ct)).toBe(secret);
  });

  it("rejects decryption with the wrong master key", async () => {
    const ct = await encryptString("key-one-0123456789abcdef0123456789abcdef", "supersecret");
    await expect(decryptString("key-two-0123456789abcdef0123456789abcdef", ct)).rejects.toThrow();
  });

  it("rejects malformed ciphertext payloads", async () => {
    await expect(
      decryptString("k-0123456789abcdef0123456789abcdef", "no-dot-here"),
    ).rejects.toThrow("malformed");
  });

  it("produces different ciphertexts per call (random IV)", async () => {
    const a = await encryptString("m-0123456789abcdef0123456789abcdef", "same-value");
    const b = await encryptString("m-0123456789abcdef0123456789abcdef", "same-value");
    expect(a).not.toBe(b);
  });

  it("verifies password hashes correctly", async () => {
    const hash = await hashPassword("jwt-secret", "admin", "correct horse");
    expect((await verifyPassword("jwt-secret", "admin", "correct horse", hash)).ok).toBe(true);
    expect((await verifyPassword("jwt-secret", "admin", "wrong", hash)).ok).toBe(false);
    expect((await verifyPassword("jwt-secret", "other-user", "correct horse", hash)).ok).toBe(
      false,
    );
  });

  it("hashes are deterministic per (secret, user, password) but differ across users/secrets", async () => {
    const a = await hashPassword("s", "admin", "pw");
    const b = await hashPassword("s", "admin", "pw");
    const c = await hashPassword("s", "root", "pw");
    const d = await hashPassword("s2", "admin", "pw");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it("constantTimeEqual works", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("generatePassword yields long alphanumeric passwords", () => {
    for (let i = 0; i < 20; i++) {
      const p = generatePassword(20);
      expect(p).toMatch(/^[A-Za-z0-9]{20}$/);
    }
  });
});

describe("regression: master key strength", () => {
  it("rejects MASTER_KEY shorter than 32 characters", async () => {
    await expect(encryptString("short-key", "secret")).rejects.toThrow(/too weak/i);
  });

  it("accepts a 32+ character master key", async () => {
    const mk = "a".repeat(32);
    const ct = await encryptString(mk, "secret");
    expect(await decryptString(mk, ct)).toBe("secret");
  });
});

describe("regression: legacy pepper migration", () => {
  it("verifies legacy-pepper hashes and flags needsRehash", async () => {
    const secret = "jwt-secret-for-legacy-test-0123456789";
    const username = "admin";
    const password = "legacy-password-123";
    // Hash the way the pre-HKDF scheme did.
    const legacyPepper = await hmacHex(secret, "consenso-password-pepper:v1");
    const legacyHash = await hmacHex(legacyPepper, `admin:${username}:${password}`);
    const result = await verifyPassword(secret, username, password, legacyHash);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
    // Current-scheme hash reports no rehash need.
    const fresh = await hashPassword(secret, username, password);
    const current = await verifyPassword(secret, username, password, fresh);
    expect(current.ok).toBe(true);
    expect(current.needsRehash).toBe(false);
    // Wrong password fails either way.
    expect((await verifyPassword(secret, username, "wrong", legacyHash)).ok).toBe(false);
  });
});
