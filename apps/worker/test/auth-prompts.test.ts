import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  extractSessionToken,
  sessionCookie,
  signSession,
  verifySession,
} from "../src/core/auth";
import { buildConsensusSystemPrompt, buildModeratorUserPrompt } from "../src/core/prompts";

describe("auth sessions", () => {
  it("signs and verifies a session token", async () => {
    const { token, expiresAt } = await signSession("secret", "admin");
    expect(await verifySession("secret", token)).toBe("admin");
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects a token signed with a different secret", async () => {
    const { token } = await signSession("secret-a", "admin");
    expect(await verifySession("secret-b", token)).toBe(null);
  });

  it("rejects tampered payloads", async () => {
    const { token } = await signSession("secret", "admin");
    const [h, p, sig] = token.split(".");
    // Re-sign the payload claim with a different username encoded in place: tamper the payload only.
    const tampered = `${h}.${Buffer.from(JSON.stringify({ sub: "attacker", iat: 1, exp: Math.floor(Date.now() / 1000) + 999 })).toString("base64url")}.${sig}`;
    expect(await verifySession("secret", tampered)).toBe(null);
  });

  it("rejects expired tokens", async () => {
    // Craft manually with exp in the past.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "admin", iat: 1, exp: 1 })).toString(
      "base64url",
    );
    const { hmacHex } = await import("../src/core/crypto");
    const sig = await hmacHex("secret", `${header}.${payload}`);
    expect(await verifySession("secret", `${header}.${payload}.${sig}`)).toBe(null);
  });

  it("round-trips the session cookie", async () => {
    const { token, expiresAt } = await signSession("s", "admin");
    const cookie = sessionCookie(token, expiresAt);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const req = new Request("https://x/", {
      headers: { cookie: `other=1; ${cookie.split(";")[0]}` },
    });
    expect(await verifySession("s", extractSessionToken(req) ?? "")).toBe("admin");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});

describe("prompts", () => {
  it("embeds agent name and differ per round", () => {
    const r1 = buildConsensusSystemPrompt("Agent_Cohere", 1);
    const r2 = buildConsensusSystemPrompt("Agent_Cohere", 2);
    expect(r1).toContain("Agent_Cohere");
    expect(r1).toContain("RONDA 1");
    expect(r2).toContain("RONDA 2");
    expect(r1).not.toContain("__NAME__");
  });

  it("moderator prompt includes question, answers and key points", () => {
    const p = buildModeratorUserPrompt("¿Cómo usar X?", [
      { name: "A", confidence: 90, answer: "Respuesta de A", keyPoints: ["p1"] },
      { name: "B", confidence: 70, answer: "Respuesta de B", keyPoints: [] },
    ]);
    expect(p).toContain("¿Cómo usar X?");
    expect(p).toContain("Respuesta de A");
    expect(p).toContain("p1");
    expect(p).toContain("confianza declarada: 90%");
  });
});
