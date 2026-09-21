import type { StreamEvent } from "@consenso/shared";
import { describe, expect, it } from "vitest";
import { type AgentRuntime, ConsensusError, runConsensus } from "../src/core/consensus";

function makeAgent(key: string, model: string): AgentRuntime {
  return {
    key,
    name: `Agent_${key}`,
    display_name: key.toUpperCase(),
    url: "https://mock.local/v1/chat/completions",
    model,
    api_key: "sk-mock",
    timeout_s: 5,
  };
}

function expertJson(name: string, confidence: number, agree: string[] = []): string {
  return JSON.stringify({
    agent_id: name,
    confidence,
    answer:
      `Análisis extenso de ${name} con más de cuatrocientas palabras para cumplir el mínimo. `.repeat(
        8,
      ),
    key_points: [`${name}: punto clave 1`, `${name}: punto clave 2`],
    concerns: [`${name}: limitación`],
    agree_with: agree,
  });
}

/** Mock LLM: participants answer JSON, model "mod" answers plain text,
 *  any model containing "fail" returns 500, "-slow" hangs (timeout). */
function mockFetcher(opts: { moderatorFails?: boolean } = {}): typeof fetch {
  return (async (input: Request | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model: string;
      messages: { content: string }[];
    };
    const model = body.model;
    const isRound2 = body.messages.some(
      (m) => m.content.includes("RONDA 2") || m.content.includes("Respuestas de otros expertos"),
    );
    if (model === "mod") {
      if (opts.moderatorFails) return new Response("mod down", { status: 503 });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "## Síntesis final\n\nRespuesta moderada completa." } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (model.includes("fail")) return new Response("dead", { status: 500 });
    if (model.includes("slow")) {
      return new Promise<Response>(() => {}); // hangs → AbortSignal.timeout fires
    }
    const conf = isRound2 ? 85 : 80;
    const agree = isRound2 ? [model] : [];
    return new Response(
      JSON.stringify({ choices: [{ message: { content: expertJson(model, conf, agree) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function collect() {
  const events: StreamEvent[] = [];
  return { events, emit: (e: StreamEvent) => events.push(e) };
}

describe("runConsensus", () => {
  const participants = [
    makeAgent("a", "expert-a"),
    makeAgent("b", "expert-b"),
    makeAgent("c", "expert-c"),
  ];
  const moderator = makeAgent("groq", "mod");

  it("happy path: 2 rounds + moderation, ordered stream events, metrics", async () => {
    const { events, emit } = collect();
    const result = await runConsensus({
      question: "¿Qué estrategia seguir para aprender IA?",
      participants,
      moderator,
      emit,
      fetcher: mockFetcher(),
    });

    const types = events.map((e) => e.type);
    // Engine emits round1 start first; the HTTP route adds the initial "status" event.
    expect(types[0]).toBe("round");
    expect(types).toContain("round");
    expect(types.filter((t) => t === "agent")).toHaveLength(6);
    // The engine ends with moderation-end; the route appends the "final" event (tested in integration).
    expect(types[types.length - 1]).toBe("moderation");
    expect(events[events.length - 1]).toMatchObject({ type: "moderation", status: "end" });

    expect(result.consensus).toContain("Síntesis final");
    expect(result.moderator_fallback).toBe(false);
    expect(result.degraded).toBe(false);
    expect(result.metrics.agents_ok).toBe(3);
    expect(result.metrics.agreement_level).toBe("MODERATE"); // 3 agents × 1 agree in round2
    expect(result.unavailable_agents).toHaveLength(0);
    // Round 2 answers present, round 1 kept as history
    for (const p of result.participants) {
      expect(p.rounds[0]?.status).toBe("ok");
      expect(p.rounds[1]?.status).toBe("ok");
    }
  });

  it("one failing participant is reported unavailable; consensus still completes", async () => {
    const { events, emit } = collect();
    const mixed = [
      makeAgent("a", "expert-a"),
      makeAgent("b", "expert-b"),
      makeAgent("c", "expert-c-fail"),
    ];
    const result = await runConsensus({
      question: "Pregunta suficientemente larga para el test",
      participants: mixed,
      moderator,
      emit,
      fetcher: mockFetcher(),
    });

    expect(result.metrics.agents_ok).toBe(2);
    expect(result.degraded).toBe(true);
    expect(result.unavailable_agents).toEqual(["C"]);
    const c = result.participants.find((p) => p.key === "c");
    expect(c?.unavailable).toBe(true);
    expect(c?.error).toContain("HTTP 500");
    // error events emitted for the failed agent
    const agentErrors = events.filter((e) => e.type === "agent" && e.status === "error");
    expect(agentErrors.length).toBeGreaterThanOrEqual(2); // both rounds
  });

  it("moderator failure produces clearly-labeled local synthesis", async () => {
    const { emit } = collect();
    const result = await runConsensus({
      question: "Pregunta sobre síntesis de respuestas IA",
      participants,
      moderator,
      emit,
      fetcher: mockFetcher({ moderatorFails: true }),
    });
    expect(result.moderator_fallback).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.consensus).toContain("Síntesis automática local");
    expect(result.consensus).toContain("Puntos clave coincidentes");
  });

  it("throws not_enough_participants when fewer than 2 agents answer", async () => {
    const { emit } = collect();
    const allFail = [makeAgent("a", "fail-a"), makeAgent("b", "fail-b"), makeAgent("c", "fail-c")];
    await expect(
      runConsensus({
        question: "Pregunta que nadie podrá responder aquí",
        participants: allFail,
        moderator,
        emit,
        fetcher: mockFetcher(),
      }),
    ).rejects.toThrow(ConsensusError);
    await expect(
      runConsensus({
        question: "Pregunta que nadie podrá responder aquí",
        participants: allFail,
        moderator,
        emit,
        fetcher: mockFetcher(),
      }),
    ).rejects.toMatchObject({ code: "not_enough_participants" });
  });

  it("round 2 prompt includes round 1 context", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: Request | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        model: string;
        messages: { content: string }[];
      };
      seen.push(...body.messages.map((m) => m.content));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: expertJson(body.model, 80) } }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    await runConsensus({
      question: "Pregunta con contexto entre rondas",
      participants,
      moderator,
      emit: () => {},
      fetcher,
    });
    expect(seen.some((c) => c.includes("Respuestas de otros expertos"))).toBe(true);
    expect(seen.some((c) => c.includes("A"))).toBe(true); // round1 answers visible by display name
  });
});
