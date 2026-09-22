import { LIMITS, consensusRequestSchema, individualRequestSchema } from "@consenso/shared";
/**
 * Public API: agents list, consensus (SSE stream), individual, health.
 */
import { Hono } from "hono";
import { cacheGet, cacheKey, cachePut } from "../core/cache";
import { ConsensusError, runConsensus, runIndividual } from "../core/consensus";
import { getAgent, listAgents, rateLimit } from "../core/db";
import { jsonError, toPublicAgent, toRuntimeAgent } from "../core/helpers";
import type { Env } from "../env";
import { clientIp } from "../env";

export const publicRoutes = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

// ---------------------------------------------------------------------------
// GET /api/agents — public, read-only, no secrets
// ---------------------------------------------------------------------------

publicRoutes.get("/api/agents", async (c) => {
  const rows = await listAgents(c.env.DB, true);
  const participants = rows.filter((r) => r.role === "participant").map(toPublicAgent);
  const moderatorRow = rows.find((r) => r.role === "moderator") ?? null;
  return c.json({
    success: true,
    participants,
    moderator: moderatorRow ? toPublicAgent(moderatorRow) : null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/consensus — validated + rate limited, streams progress as SSE
// ---------------------------------------------------------------------------

publicRoutes.post("/api/consensus", async (c) => {
  // Cheap guard first: the rate limiter runs before any body parsing so a
  // flood pays nothing but a D1 counter.
  const ip = clientIp(c.req.raw);
  const verdict = await rateLimit(
    c.env.DB,
    `consensus:${ip}`,
    LIMITS.CONSENSUS_MAX,
    LIMITS.CONSENSUS_WINDOW_S,
  );
  if (!verdict.allowed) {
    return jsonError(
      c,
      429,
      "rate_limited",
      "Demasiadas consultas de consenso; inténtalo más tarde.",
    );
  }

  const body = await c.req.json().catch(() => null);
  const parsed = consensusRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_request", parsed.error.issues[0]?.message ?? "invalid");
  }
  const { question, selected_agents } = parsed.data;

  // Resolve agents.
  const rows = await listAgents(c.env.DB, true);
  const moderatorRow = rows.find((r) => r.role === "moderator");
  if (!moderatorRow) {
    return jsonError(c, 409, "no_moderator", "No hay moderadora activa configurada.");
  }
  const selectedRows = selected_agents.map((k) =>
    rows.find((r) => r.key === k && r.role === "participant"),
  );
  if (selectedRows.some((r) => !r)) {
    return jsonError(
      c,
      400,
      "invalid_agents",
      "Uno o más agentes seleccionados no son participantes activos.",
    );
  }

  // Cache check before any expensive work — a hit costs no LLM calls.
  const key = await cacheKey(
    question,
    selectedRows.map((r) => `${r!.key}|${r!.url}|${r!.model}|${r!.display_name}`),
    `${moderatorRow.key}|${moderatorRow.url}|${moderatorRow.model}|${moderatorRow.display_name}`,
  );
  const cached = cacheGet(key);
  if (cached) {
    const hit = { ...cached, from_cache: true };
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ type: "status", stage: "cache", message: "cache" } satisfies import("@consenso/shared").StreamEvent)}\n\n`,
          ),
        );
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ type: "final", result: hit } satisfies import("@consenso/shared").StreamEvent)}\n\n`,
          ),
        );
        controller.close();
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }

  const participants = await Promise.all(
    selectedRows.map((r) => toRuntimeAgent(r!, c.env.MASTER_KEY)),
  );
  const missingKeys = selected_agents.filter((_, i) => participants[i] === null);
  if (missingKeys.length > 0) {
    return jsonError(
      c,
      400,
      "missing_api_keys",
      `Agentes sin API key configurada: ${missingKeys.join(", ")}`,
    );
  }
  const moderator = await toRuntimeAgent(moderatorRow, c.env.MASTER_KEY);
  if (!moderator) {
    return jsonError(c, 400, "moderator_no_key", "La moderadora no tiene API key configurada.");
  }

  const fetcher = c.env.LLM_FETCHER;
  const enc = new TextEncoder();
  const abort = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      // Emitting after the client disconnects must never throw: the stream
      // controller is closed the moment the request is cancelled.
      const emit = (event: import("@consenso/shared").StreamEvent) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* client gone — events are dropped, work continues to cancellation */
        }
      };
      // Heartbeat: silent stretches between LLM calls can last minutes, and
      // idle proxies (60-300s) would sever the stream. SSE comment lines are
      // ignored by every client parser but keep the connection alive.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          /* client gone */
        }
      }, 15_000);
      emit({ type: "status", stage: "start", message: "start" });
      try {
        const result = await runConsensus({
          question,
          participants: participants as NonNullable<(typeof participants)[number]>[],
          moderator,
          emit,
          fetcher,
          signal: abort.signal,
        });
        // Never cache a run that was cancelled mid-flight (e.g. an abort
        // landing during moderation would otherwise cache a fallback result).
        if (!abort.signal.aborted) cachePut(key, result);
        emit({ type: "final", result });
      } catch (e) {
        if (e instanceof ConsensusError) {
          emit({ type: "error", code: e.code, message: e.message });
        } else {
          console.error(`[${c.get("requestId")}] consensus failure`, e);
          emit({ type: "error", code: "internal", message: "Error interno del sistema." });
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed by client cancellation */
        }
      }
    },
    // Client disconnect / Stop button: cancel every in-flight LLM call.
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, { headers: sseHeaders() });
});

function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

// ---------------------------------------------------------------------------
// POST /api/individual — single agent query, plain JSON
// ---------------------------------------------------------------------------

publicRoutes.post("/api/individual", async (c) => {
  const ip = clientIp(c.req.raw);
  const verdict = await rateLimit(
    c.env.DB,
    `individual:${ip}`,
    LIMITS.INDIVIDUAL_MAX,
    LIMITS.INDIVIDUAL_WINDOW_S,
  );
  if (!verdict.allowed) {
    return jsonError(
      c,
      429,
      "rate_limited",
      "Demasiadas consultas individuales; inténtalo más tarde.",
    );
  }

  const body = await c.req.json().catch(() => null);
  const parsed = individualRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_request", parsed.error.issues[0]?.message ?? "invalid");
  }
  const { question, agent: agentKey } = parsed.data;

  const row = await getAgent(c.env.DB, agentKey);
  if (!row || !row.active) {
    return jsonError(c, 404, "agent_not_found", `Agente '${agentKey}' no encontrado o inactivo.`);
  }
  const runtime = await toRuntimeAgent(row, c.env.MASTER_KEY);
  if (!runtime) {
    return jsonError(c, 400, "missing_api_key", "El agente no tiene API key configurada.");
  }

  const abort = new AbortController();
  // If the client already left during the awaits above, an abort event never
  // fires again — check directly before wiring the listener.
  if (c.req.raw.signal.aborted) abort.abort();
  else c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const started = Date.now();
  try {
    const out = await runIndividual({
      question,
      agent: runtime,
      fetcher: c.env.LLM_FETCHER,
      signal: abort.signal,
    });
    return c.json({
      success: true,
      result: {
        question,
        agent_key: agentKey,
        display_name: row.display_name,
        answer: out.answer,
        key_points: out.key_points,
        concerns: out.concerns,
        confidence: out.confidence,
        processing_time_s: Math.round(((Date.now() - started) / 1000) * 10) / 10,
      },
    });
  } catch (e) {
    if (e instanceof ConsensusError) {
      return jsonError(c, 502, e.code, e.message);
    }
    console.error(`[${c.get("requestId")}] individual failure`, e);
    return jsonError(c, 500, "internal", "Error interno del sistema.");
  }
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

publicRoutes.get("/health", async (c) => {
  const rows = await listAgents(c.env.DB);
  return c.json({
    status: "ok",
    version: "2.0.0",
    agents_total: rows.length,
    participants_active: rows.filter((r) => r.active && r.role === "participant").length,
    moderator_active: rows.some((r) => r.active && r.role === "moderator"),
    secrets_configured: {
      master_key: Boolean(c.env.MASTER_KEY),
      master_key_strong: Boolean(c.env.MASTER_KEY && c.env.MASTER_KEY.length >= 32),
      jwt_secret: Boolean(c.env.JWT_SECRET),
    },
  });
});
