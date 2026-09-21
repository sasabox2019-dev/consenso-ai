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

export const publicRoutes = new Hono<{ Bindings: Env }>();

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
  const body = await c.req.json().catch(() => null);
  const parsed = consensusRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_request", JSON.stringify(parsed.error.issues[0]?.message));
  }
  const { question, selected_agents } = parsed.data;

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

  const key = await cacheKey(question, selected_agents);
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

  const fetcher = c.env.LLM_FETCHER;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: import("@consenso/shared").StreamEvent) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      emit({ type: "status", stage: "start", message: "start" });
      try {
        const result = await runConsensus({
          question,
          participants: participants as NonNullable<(typeof participants)[number]>[],
          moderator,
          emit,
          fetcher,
        });
        cachePut(key, result);
        emit({ type: "final", result });
      } catch (e) {
        if (e instanceof ConsensusError) {
          emit({ type: "error", code: e.code, message: e.message });
        } else {
          console.error("consensus failure", e);
          emit({ type: "error", code: "internal", message: "Error interno del sistema." });
        }
      }
      controller.close();
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
  const body = await c.req.json().catch(() => null);
  const parsed = individualRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_request", JSON.stringify(parsed.error.issues[0]?.message));
  }
  const { question, agent: agentKey } = parsed.data;

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

  const row = await getAgent(c.env.DB, agentKey);
  if (!row || !row.active) {
    return jsonError(c, 404, "agent_not_found", `Agente '${agentKey}' no encontrado o inactivo.`);
  }
  const runtime = await toRuntimeAgent(row, c.env.MASTER_KEY);
  if (!runtime) {
    return jsonError(c, 400, "missing_api_key", "El agente no tiene API key configurada.");
  }

  const started = Date.now();
  try {
    const out = await runIndividual({ question, agent: runtime, fetcher: c.env.LLM_FETCHER });
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
    console.error("individual failure", e);
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
      jwt_secret: Boolean(c.env.JWT_SECRET),
    },
  });
});
