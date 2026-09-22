#!/usr/bin/env node
/**
 * End-to-end test: boots the mock LLM server and the full app (node runtime,
 * SQLite D1 shim), then exercises the complete user + admin flow over HTTP.
 * Verifies: bootstrap, login, agents listing, consensus SSE with all events,
 * cache hit, individual query, audit trail, auth rejections.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = join(here, "..", "..");
// Random high port: never collide with a dev server the user has running.
const PORT = 9200 + Math.floor(Math.random() * 700);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await wait(250);
  }
  return false;
}

function spawnNode(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: workerRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`  [srv] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`  [srv!] ${d}`));
  return child;
}

async function main() {
  // Ensure dev secrets exist (same file `npm run dev` uses).
  const devVarsFile = join(workerRoot, ".dev-vars.json");
  if (!existsSync(devVarsFile)) {
    writeFileSync(
      devVarsFile,
      JSON.stringify(
        {
          master_key: randomBytes(32).toString("hex"),
          jwt_secret: randomBytes(32).toString("hex"),
        },
        null,
        2,
      ),
    );
  }

  const mock = spawnNode(["test/mock-llm-server.mjs"], {});
  const dataDir = mkdtempSync(join(tmpdir(), "consenso-e2e-"));
  const appSrv = spawnNode(["--import", "tsx", "src/node-dev.ts"], {
    SEED_DEMO: "1",
    DEMO_LLM_URL: "http://127.0.0.1:8790/v1/chat/completions",
    DEV_DB_DIR: dataDir,
    PORT: String(PORT),
  });

  try {
    // --- servers up ---------------------------------------------------------
    check("mock LLM server ready", await waitFor("http://127.0.0.1:8790/health"));
    check("app server ready", await waitFor(`${BASE}/health`));

    // --- health -------------------------------------------------------------
    const health = await (await fetch(`${BASE}/health`)).json();
    check("health reports 4 seeded agents", health.agents_total === 4, JSON.stringify(health));
    check(
      "health: secrets configured",
      health.secrets_configured.master_key && health.secrets_configured.jwt_secret,
    );

    // --- public agents ------------------------------------------------------
    const agentsRes = await fetch(`${BASE}/api/agents`);
    const agents = await agentsRes.json();
    check(
      "GET /api/agents: 3 participants + moderator",
      agents.participants?.length === 3 && agents.moderator?.key === "groq",
      JSON.stringify(agents),
    );
    check("no api keys leaked", !JSON.stringify(agents).includes("demo-key"));

    // --- admin auth ---------------------------------------------------------
    const session0 = await (await fetch(`${BASE}/api/admin/session`)).json();
    check("session: needs bootstrap", session0.needs_bootstrap === true);

    const unauthorized = await fetch(`${BASE}/api/admin/agents`);
    check("admin list without session → 401", unauthorized.status === 401);

    const password = "e2e-password-2026-long";
    const bootRes = await fetch(`${BASE}/api/admin/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password }),
    });
    const setCookie = bootRes.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0];
    check(
      "bootstrap creates admin + cookie",
      bootRes.status === 200 && cookie.startsWith("consenso_session="),
      `status=${bootRes.status}`,
    );

    const boot2 = await fetch(`${BASE}/api/admin/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "otheradmin", password }),
    });
    check("second bootstrap → 409", boot2.status === 409);

    // --- admin CRUD ---------------------------------------------------------
    const list = await (await fetch(`${BASE}/api/admin/agents`, { headers: { cookie } })).json();
    check(
      "admin list shows 4 agents with keys",
      list.agents?.length === 4 && list.agents.every((a) => a.has_api_key),
    );

    const create = await fetch(`${BASE}/api/admin/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        key: "together",
        name: "Agent_Together",
        display_name: "Together",
        url: "http://127.0.0.1:8790/v1/chat/completions",
        model: "demo-expert-d",
        api_key: "key-together-1",
        timeout_s: 20,
        role: "participant",
      }),
    });
    check("create new agent", create.status === 200);

    const test1 = await (
      await fetch(`${BASE}/api/admin/agents/together/test`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({}),
      })
    ).json();
    check("test-connection (stored config + mock)", test1.success === true, JSON.stringify(test1));

    // --- consensus over SSE --------------------------------------------------
    const consensusBody = JSON.stringify({
      question: "¿Cuál es la mejor forma de empezar a aprender programación desde cero?",
      selected_agents: ["openrouter", "deepseek", "mistral"],
    });
    const t0 = Date.now();
    const cRes = await fetch(`${BASE}/api/consensus`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: consensusBody,
    });
    check(
      "consensus: SSE content-type",
      (cRes.headers.get("content-type") ?? "").includes("text/event-stream"),
    );

    const text = await cRes.text();
    const events = text
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) =>
        JSON.parse(
          chunk
            .split("\n")
            .find((l) => l.startsWith("data: "))
            .slice(6),
        ),
      );
    const kinds = events.map((e) => e.type);
    check("consensus: starts with status", kinds[0] === "status" && events[0].stage === "start");
    check(
      "consensus: 6 agent events (3×2 rounds)",
      kinds.filter((k) => k === "agent").length === 6,
      JSON.stringify(kinds),
    );
    check("consensus: moderation events", kinds.includes("moderation"));
    const final = events.find((e) => e.type === "final");
    check("consensus: final event with result", Boolean(final));
    check(
      "consensus: moderator text present",
      final.result.consensus.includes("Respuesta consensuada"),
    );
    check(
      "consensus: all 3 agents ok",
      final.result.metrics.agents_ok === 3 && final.result.unavailable_agents.length === 0,
    );
    check(
      "consensus: metrics sane",
      final.result.metrics.confidence > 0 && final.result.metrics.processing_time_s >= 0,
    );
    check(
      "consensus: per-participant rounds recorded",
      final.result.participants.every(
        (p) => p.rounds[0].status === "ok" && p.rounds[1].status === "ok",
      ),
    );
    console.log(`  (consensus took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    // --- cache hit -----------------------------------------------------------
    const cRes2 = await fetch(`${BASE}/api/consensus`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: consensusBody,
    });
    const text2 = await cRes2.text();
    const events2 = text2
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) =>
        JSON.parse(
          chunk
            .split("\n")
            .find((l) => l.startsWith("data: "))
            .slice(6),
        ),
      );
    check(
      "consensus cache hit on repeat",
      events2.some((e) => e.type === "status" && e.stage === "cache") &&
        events2.find((e) => e.type === "final").result.from_cache === true,
    );

    // --- individual ----------------------------------------------------------
    const indRes = await fetch(`${BASE}/api/individual`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Explícame qué es un hash criptográfico",
        agent: "deepseek",
      }),
    });
    const ind = await indRes.json();
    check(
      "individual query works",
      indRes.status === 200 &&
        ind.result.answer.includes("Análisis del experto") &&
        ind.result.display_name === "DeepSeek",
    );

    // --- failure path: consensus with a broken agent --------------------------
    const failRes = await fetch(`${BASE}/api/admin/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        key: "broken",
        name: "Agent_Broken",
        display_name: "BrokenAI",
        url: "http://127.0.0.1:8790/v1/chat/completions",
        model: "demo-fail-model",
        api_key: "key-broken-123",
        timeout_s: 10,
        role: "participant",
      }),
    });
    check("create broken agent", failRes.status === 200);
    const fRes = await fetch(`${BASE}/api/consensus`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "¿Cómo afecta la deriva continental a las rutas de migración de aves hoy?",
        selected_agents: ["openrouter", "deepseek", "broken"],
      }),
    });
    const fText = await fRes.text();
    const fEvents = fText
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) =>
        JSON.parse(
          chunk
            .split("\n")
            .find((l) => l.startsWith("data: "))
            .slice(6),
        ),
      );
    const fFinal = fEvents.find((e) => e.type === "final");
    check(
      "consensus degrades gracefully with failing agent",
      Boolean(fFinal) &&
        fFinal.result.metrics.agents_ok === 2 &&
        fFinal.result.degraded === true &&
        fFinal.result.unavailable_agents.includes("BrokenAI"),
      fFinal ? JSON.stringify(fFinal.result.metrics) : "no final",
    );
    check(
      "failing agent reported with error detail",
      fFinal.result.participants.find((p) => p.key === "broken").error.includes("HTTP 500"),
    );

    // --- audit ---------------------------------------------------------------
    const audit = await (await fetch(`${BASE}/api/admin/audit`, { headers: { cookie } })).json();
    const actions = audit.entries.map((e) => e.action);
    check(
      "audit trail: bootstrap, agent ops, logins",
      ["bootstrap", "agent_create", "test_connection"].every((a) => actions.includes(a)),
      JSON.stringify(actions),
    );

    // --- logout --------------------------------------------------------------
    const logoutRes = await fetch(`${BASE}/api/admin/logout`, {
      method: "POST",
      headers: { cookie },
    });
    check("logout clears cookie", logoutRes.status === 200);
    const afterLogout = await fetch(`${BASE}/api/admin/agents`, { headers: { cookie } });
    check("session invalid after logout", afterLogout.status === 401);
  } finally {
    appSrv.kill("SIGTERM");
    mock.kill("SIGTERM");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "🎉" : "💥"} E2E: ${results.length - failed.length}/${results.length} checks passed`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
