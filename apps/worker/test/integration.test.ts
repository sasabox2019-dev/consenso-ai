import { mkdtempSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsensusResult, StreamEvent } from "@consenso/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import app from "../src/index";
import { NodeSqliteD1 } from "../src/node/d1-sqlite";

function makeEnv(opts: { mock?: typeof fetch; masterKey?: string } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "consenso-test-"));
  const db = new NodeSqliteD1(join(dir, "test.sqlite"));
  const migrationsDir = join(import.meta.dirname, "..", "migrations");
  for (const m of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(migrationsDir, m), "utf8"));
  }
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("no ui in tests", { status: 404 }) },
    MASTER_KEY:
      opts.masterKey ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    JWT_SECRET: "jwt-test-secret-with-enough-length-for-hmac",
    LLM_FETCHER: opts.mock,
  };
}

function cookieOf(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

function expertJson(name: string, confidence: number): string {
  return JSON.stringify({
    agent_id: name,
    confidence,
    answer: `Análisis completo de ${name}. `.repeat(50),
    key_points: [`${name} punto 1`],
    concerns: [],
    agree_with: [],
  });
}

function mockLLM(): typeof fetch {
  return (async (input: Request | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    if (body.model === "mod") {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "# Consenso\n\nTexto moderado final." } }],
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: expertJson(body.model, 82) } }] }),
      { status: 200 },
    );
  }) as typeof fetch;
}

async function readSse(res: Response): Promise<StreamEvent[]> {
  const text = await res.text();
  const events: StreamEvent[] = [];
  for (const chunk of text.split("\n\n")) {
    const line = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (line) events.push(JSON.parse(line.slice(6)) as StreamEvent);
  }
  return events;
}

/** Creates admin + 4 agents (1 moderator + 3 participants). Returns cookie. */
async function setupAgents(env: Env): Promise<string> {
  const res = await app.request(
    "/api/admin/bootstrap",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "long-password-123" }),
    },
    env,
  );
  expect(res.status).toBe(200);
  const cookie = cookieOf(res);

  const mk = async (payload: object) => {
    const r = await app.request(
      "/api/admin/agents",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(r.status).toBe(200);
  };
  await mk({
    key: "groq",
    name: "Agent_Groq",
    display_name: "Groq",
    url: "https://mock.local/v1/chat/completions",
    model: "mod",
    api_key: "gsk_test_1234",
    timeout_s: 10,
    role: "moderator",
  });
  await mk({
    key: "a",
    name: "Agent_A",
    display_name: "Alpha",
    url: "https://mock.local/v1/chat/completions",
    model: "alpha",
    api_key: "key-a-12345",
    timeout_s: 10,
    role: "participant",
  });
  await mk({
    key: "b",
    name: "Agent_B",
    display_name: "Beta",
    url: "https://mock.local/v1/chat/completions",
    model: "beta",
    api_key: "key-b-12345",
    timeout_s: 10,
    role: "participant",
  });
  await mk({
    key: "c",
    name: "Agent_C",
    display_name: "Gamma",
    url: "https://mock.local/v1/chat/completions",
    model: "gamma",
    api_key: "key-c-12345",
    timeout_s: 10,
    role: "participant",
  });
  return cookie;
}

let env: Env;

beforeEach(() => {
  env = makeEnv({ mock: mockLLM() });
});

describe("health", () => {
  it("reports secrets and zero agents initially", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      agents_total: number;
      secrets_configured: { master_key: boolean };
    };
    expect(body.status).toBe("ok");
    expect(body.agents_total).toBe(0);
    expect(body.secrets_configured.master_key).toBe(true);
  });
});

describe("admin bootstrap & auth", () => {
  it("bootstrap → authed CRUD → cannot bootstrap twice", async () => {
    const boot = await app.request(
      "/api/admin/bootstrap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "long-password-123" }),
      },
      env,
    );
    expect(boot.status).toBe(200);
    const cookie = cookieOf(boot);

    // Second bootstrap with VALID credentials loses the atomic insert → 409.
    const again = await app.request(
      "/api/admin/bootstrap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "other", password: "long-password-123" }),
      },
      env,
    );
    expect(again.status).toBe(409);

    // Invalid payload (short password) is rejected by validation → 400.
    const bad = await app.request(
      "/api/admin/bootstrap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "x", password: "short" }),
      },
      env,
    );
    expect(bad.status).toBe(400);
  });

  it("admin routes require session; wrong cookie rejected", async () => {
    const res = await app.request("/api/admin/agents", {}, env);
    expect(res.status).toBe(401);

    const res2 = await app.request(
      "/api/admin/agents",
      { headers: { cookie: "consenso_session=forged.token.value" } },
      env,
    );
    expect(res2.status).toBe(401);
  });

  it("login works after logout; wrong password 401", async () => {
    await app.request(
      "/api/admin/bootstrap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "long-password-123" }),
      },
      env,
    );

    const bad = await app.request(
      "/api/admin/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "wrong" }),
      },
      env,
    );
    expect(bad.status).toBe(401);

    const good = await app.request(
      "/api/admin/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "long-password-123" }),
      },
      env,
    );
    expect(good.status).toBe(200);
    expect(cookieOf(good)).toContain("consenso_session=");

    const session = await app.request(
      "/api/admin/session",
      { headers: { cookie: cookieOf(good) } },
      env,
    );
    const body = (await session.json()) as { authenticated: boolean; username: string };
    expect(body.authenticated).toBe(true);
    expect(body.username).toBe("admin");
  });
});

describe("agents CRUD", () => {
  it("create → list → update → delete, with role rules", async () => {
    const cookie = await setupAgents(env);

    const list = await app.request("/api/admin/agents", { headers: { cookie } }, env);
    const body = (await list.json()) as {
      agents: Array<{ key: string; role: string; has_api_key: boolean }>;
    };
    expect(body.agents).toHaveLength(4);
    expect(body.agents.every((a) => a.has_api_key)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("gsk_test_1234"); // never leak keys

    // second moderator rejected
    const mod2 = await app.request(
      "/api/admin/agents",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          key: "mod2",
          name: "Nm",
          display_name: "Nm",
          url: "https://x.local/v1",
          model: "m",
          api_key: "key-mod2-123",
          role: "moderator",
        }),
      },
      env,
    );
    expect(mod2.status).toBe(409);

    // duplicate key rejected
    const dup = await app.request(
      "/api/admin/agents",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          key: "a",
          name: "Nm",
          display_name: "Nm",
          url: "https://x.local/v1",
          model: "m",
          api_key: "key-dup-12345",
        }),
      },
      env,
    );
    expect(dup.status).toBe(409);

    // update participant role
    const upd = await app.request(
      "/api/admin/agents/a",
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ display_name: "Alfa", timeout_s: 20 }),
      },
      env,
    );
    expect(upd.status).toBe(200);

    // deactivate a participant
    const deact = await app.request(
      "/api/admin/agents/a",
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ active: false }),
      },
      env,
    );
    expect(deact.status).toBe(200);

    // moderator deletion protected
    const delMod = await app.request(
      "/api/admin/agents/groq",
      { method: "DELETE", headers: { cookie } },
      env,
    );
    expect(delMod.status).toBe(409);

    // delete participant ok
    const del = await app.request(
      "/api/admin/agents/a",
      { method: "DELETE", headers: { cookie } },
      env,
    );
    expect(del.status).toBe(200);

    // audit recorded
    const auditRes = await app.request("/api/admin/audit", { headers: { cookie } }, env);
    const auditBody = (await auditRes.json()) as { entries: Array<{ action: string }> };
    const actions = auditBody.entries.map((e) => e.action);
    expect(actions).toContain("agent_create");
    expect(actions).toContain("agent_update");
    expect(actions).toContain("agent_delete");
  });
});

describe("public endpoints", () => {
  it("GET /api/agents lists participants + moderator without secrets", async () => {
    await setupAgents(env);
    const res = await app.request("/api/agents", {}, env);
    const body = (await res.json()) as {
      participants: Array<{ key: string; has_api_key: boolean }>;
      moderator: { key: string } | null;
    };
    expect(body.participants.map((p) => p.key).sort()).toEqual(["a", "b", "c"]);
    expect(body.moderator?.key).toBe("groq");
    expect(JSON.stringify(body)).not.toContain("gsk_test");
  });

  it("validation: short question rejected, wrong agent count rejected", async () => {
    await setupAgents(env);
    const short = await app.request(
      "/api/consensus",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "corta", selected_agents: ["a", "b", "c"] }),
      },
      env,
    );
    expect(short.status).toBe(400);

    const two = await app.request(
      "/api/consensus",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "Pregunta suficientemente larga aquí",
          selected_agents: ["a", "b"],
        }),
      },
      env,
    );
    expect(two.status).toBe(400);
  });

  it("consensus SSE happy path with cache hit on second identical call", async () => {
    await setupAgents(env);
    const payload = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "¿Cómo empezar a aprender inteligencia artificial?",
        selected_agents: ["a", "b", "c"],
      }),
    };

    const res1 = await app.request("/api/consensus", payload, env);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toContain("text/event-stream");
    const events1 = await readSse(res1);
    const final1 = events1.find((e) => e.type === "final") as
      | { type: "final"; result: ConsensusResult }
      | undefined;
    expect(final1).toBeDefined();
    expect(final1!.result.consensus).toContain("Texto moderado final");
    expect(final1!.result.metrics.agents_ok).toBe(3);
    expect(final1!.result.from_cache).toBe(false);
    expect(events1.filter((e) => e.type === "agent")).toHaveLength(6);

    const res2 = await app.request("/api/consensus", payload, env);
    const events2 = await readSse(res2);
    expect(events2.some((e) => e.type === "status" && e.stage === "cache")).toBe(true);
    const final2 = events2.find((e) => e.type === "final") as
      | { type: "final"; result: ConsensusResult }
      | undefined;
    expect(final2!.result.from_cache).toBe(true);
  });

  it("consensus rejects unknown/inactive participants and missing keys", async () => {
    await setupAgents(env);
    const res = await app.request(
      "/api/consensus",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "Pregunta suficientemente larga aquí",
          selected_agents: ["a", "b", "ghost"],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_agents");

    // remove a key: create an agent without key is impossible via API (api_key required),
    // so simulate by corrupting ciphertext directly.
    await env.DB.prepare("UPDATE agents SET api_key_ciphertext = 'garbage' WHERE key = 'c'").run();
    const res2 = await app.request(
      "/api/consensus",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "Pregunta suficientemente larga aquí",
          selected_agents: ["a", "b", "c"],
        }),
      },
      env,
    );
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: { code: string } };
    expect(body2.error.code).toBe("missing_api_keys");
  });

  it("individual query works and fails cleanly", async () => {
    await setupAgents(env);
    const res = await app.request(
      "/api/individual",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Explícame cómo funciona el protocolo HTTP", agent: "b" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { answer: string; display_name: string; confidence: number };
    };
    expect(body.result.display_name).toBe("Beta");
    expect(body.result.answer).toContain("Análisis completo");
    expect(body.result.confidence).toBe(82);

    const missing = await app.request(
      "/api/individual",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "Explícame cómo funciona el protocolo HTTP",
          agent: "ghost",
        }),
      },
      env,
    );
    expect(missing.status).toBe(404);
  });

  it("404 for unknown API paths", async () => {
    const res = await app.request("/api/unknown", {}, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("security headers present on API responses", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe(null); // /health is not /api/*
    const apiRes = await app.request("/api/agents", {}, env);
    expect(apiRes.headers.get("cache-control")).toBe("no-store");
  });
});

describe("rate limiting", () => {
  it("blocks the 6th failed login for the same user within the window", async () => {
    await setupAgents(env);
    for (let i = 0; i < 5; i++) {
      const r = await app.request(
        "/api/admin/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "admin", password: `wrong-${i}` }),
        },
        env,
      );
      expect(r.status).toBe(401);
    }
    // Only failures consume the lockout budget: the correct password still works.
    const good = await app.request(
      "/api/admin/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "long-password-123" }),
      },
      env,
    );
    expect(good.status).toBe(200);
    // ...but the 6th wrong attempt is throttled.
    const sixth = await app.request(
      "/api/admin/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "wrong-final" }),
      },
      env,
    );
    expect(sixth.status).toBe(429);
  });
});

describe("regression: audit fixes", () => {
  it("rejects duplicate keys in selected_agents", async () => {
    await setupAgents(env);
    const res = await app.request(
      "/api/consensus",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "Pregunta con agentes duplicados aquí",
          selected_agents: ["a", "a", "b"],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects http:// URLs on agent update (same rule as create)", async () => {
    const cookie = await setupAgents(env);
    const res = await app.request(
      "/api/admin/agents/b",
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an empty agent update", async () => {
    const cookie = await setupAgents(env);
    const res = await app.request(
      "/api/admin/agents/b",
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("empty_update");
  });

  it("rejects oversized request bodies with 413", async () => {
    await setupAgents(env);
    const res = await app.request(
      "/api/consensus",
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "20000" },
        body: JSON.stringify({
          question: "x".repeat(1000),
          selected_agents: ["a", "b", "c"],
          padding: "y".repeat(15000),
        }),
      },
      env,
    );
    expect(res.status).toBe(413);
  });

  it("reports authenticated:false on /session after logout (revocation)", async () => {
    const cookie = await setupAgents(env);
    const before = await app.request("/api/admin/session", { headers: { cookie } }, env);
    const beforeBody = (await before.json()) as { authenticated: boolean };
    expect(beforeBody.authenticated).toBe(true);

    await app.request("/api/admin/logout", { method: "POST", headers: { cookie } }, env);
    const after = await app.request("/api/admin/session", { headers: { cookie } }, env);
    const afterBody = (await after.json()) as { authenticated: boolean };
    expect(afterBody.authenticated).toBe(false);
  });

  it("password change rotates credentials and revokes old sessions", async () => {
    const cookie = await setupAgents(env);
    const res = await app.request(
      "/api/admin/password",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          current_password: "long-password-123",
          new_password: "brand-new-password-456",
        }),
      },
      env,
    );
    expect(res.status).toBe(200);

    // Old session revoked (version bumped).
    const oldSession = await app.request("/api/admin/agents", { headers: { cookie } }, env);
    expect(oldSession.status).toBe(401);

    // New password works; old one doesn't.
    const badLogin = await app.request(
      "/api/admin/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "long-password-123" }),
      },
      env,
    );
    expect(badLogin.status).toBe(401);
    const goodLogin = await app.request(
      "/api/admin/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "brand-new-password-456" }),
      },
      env,
    );
    expect(goodLogin.status).toBe(200);
  });

  it("second bootstrap cannot overwrite the first admin (atomic)", async () => {
    const first = await app.request(
      "/api/admin/bootstrap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "long-password-123" }),
      },
      env,
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      "/api/admin/bootstrap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "attacker", password: "attacker-password-1" }),
      },
      env,
    );
    expect(second.status).toBe(409);
    // The original admin still authenticates.
    const login = await app.request(
      "/api/admin/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "long-password-123" }),
      },
      env,
    );
    expect(login.status).toBe(200);
  });

  it("adds security headers including CSP", async () => {
    const res = await app.request("/api/agents", {}, env);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
