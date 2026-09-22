/**
 * The consensus engine: 3 participants × 2 rounds + 1 moderator synthesis.
 *
 * Identity is server-authoritative: display names and keys come from config,
 * the LLM's self-reported "agent_id" is ignored entirely (this is what caused
 * v1's "Respuesta de undefined" / wrong-name bugs).
 *
 * Failure policy: a failing agent is reported as unavailable with its error —
 * we NEVER fabricate content on its behalf. Consensus proceeds when at least
 * 2 participants and the moderator are alive; if the moderator fails, a clearly
 * labeled local synthesis is produced from the best available answers.
 */
import type {
  ConsensusResult,
  ParticipantResult,
  RoundAnswer,
  RoundSlot,
  StreamEvent,
} from "@consenso/shared";
import { LIMITS } from "@consenso/shared";
import { extractAgentOutput } from "./parser";
import {
  buildConsensusSystemPrompt,
  buildIndividualSystemPrompt,
  buildModeratorUserPrompt,
  buildRound2UserPrompt,
} from "./prompts";
import { type ChatMessage, callChatCompletion } from "./providers";

export interface AgentRuntime {
  key: string;
  name: string;
  display_name: string;
  url: string;
  model: string;
  api_key: string;
  timeout_s: number;
}

export class ConsensusError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface RoundOutcome {
  slot: RoundSlot;
  elapsed_ms: number;
}

async function callParticipant(
  agent: AgentRuntime,
  question: string,
  round: 1 | 2,
  round1Context: Array<{ name: string; answer: string }> | null,
  fetcher?: typeof fetch,
  signal?: AbortSignal,
): Promise<RoundOutcome> {
  const system = buildConsensusSystemPrompt(agent.name, round);
  const user =
    round === 1 || round1Context === null
      ? `Pregunta: ${question}`
      : buildRound2UserPrompt(question, round1Context);

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const res = await callChatCompletion({
    url: agent.url,
    model: agent.model,
    apiKey: agent.api_key,
    messages,
    temperature: 0.8,
    timeoutS: agent.timeout_s,
    fetcher,
    signal,
  });

  if (res.error || res.content === null) {
    const err = res.error ?? { message: "Respuesta vacía", detail: "" };
    // Public surface: status class only — never leak upstream response bodies.
    return {
      slot: { status: "error", error: err.message },
      elapsed_ms: res.elapsed_ms,
    };
  }

  const extracted = extractAgentOutput(res.content);
  if (!extracted.ok) {
    return {
      slot: { status: "error", error: "La API devolvió una respuesta vacía" },
      elapsed_ms: res.elapsed_ms,
    };
  }

  const data = extracted.data;
  const answer: RoundAnswer = {
    answer: data.answer,
    key_points: data.key_points,
    concerns: data.concerns,
    agree_with: data.agree_with,
    confidence: data.confidence,
  };
  return { slot: { status: "ok", data: answer }, elapsed_ms: res.elapsed_ms };
}

async function callModerator(
  moderator: AgentRuntime,
  question: string,
  answers: Array<{ name: string; confidence: number; answer: string; keyPoints: string[] }>,
  fetcher?: typeof fetch,
  signal?: AbortSignal,
): Promise<{ text: string; elapsed_ms: number } | { error: string; elapsed_ms: number }> {
  const res = await callChatCompletion({
    url: moderator.url,
    model: moderator.model,
    apiKey: moderator.api_key,
    messages: [{ role: "user", content: buildModeratorUserPrompt(question, answers) }],
    temperature: 0.65,
    timeoutS: moderator.timeout_s,
    fetcher,
    signal,
  });
  if (res.error || res.content === null || res.content.trim().length === 0) {
    const err = res.error ?? { message: "Respuesta vacía", detail: "" };
    return {
      error: err.message, // status class only; no upstream body fragments
      elapsed_ms: res.elapsed_ms,
    };
  }
  return { text: res.content.trim(), elapsed_ms: res.elapsed_ms };
}

/** Local, clearly-labeled synthesis used when the moderator itself is down. */
function fallbackSynthesis(
  question: string,
  answers: Array<{ name: string; confidence: number; answer: string; keyPoints: string[] }>,
  moderatorName: string,
  error: string,
): string {
  const best = [...answers].sort((a, b) => b.confidence - a.confidence);
  const points: string[] = [];
  for (const a of best) {
    for (const p of a.keyPoints) {
      if (!points.includes(p)) points.push(p);
    }
  }
  const avg = Math.round(best.reduce((s, a) => s + a.confidence, 0) / best.length);

  let out = `> ⚠️ **Síntesis automática local** — la moderadora (${moderatorName}) no está disponible en este momento (${error}). La respuesta prioritizada a continuación proviene del participante con mayor confianza declarada; no es una síntesis moderada.\n\n`;
  out += `## Respuesta prioritaria\n\n${best[0]?.answer ?? ""}\n`;
  if (best.length > 1) {
    out += `\n## Aporte del segundo participante\n\n${best[1]?.answer.slice(0, 400) ?? ""}…\n`;
  }
  if (points.length > 0) {
    out += "\n## Puntos clave coincidentes\n\n";
    for (const [i, p] of points.slice(0, 8).entries()) out += `${i + 1}. ${p}\n`;
  }
  out += `\n---\n*Pregunta: "${question}" · Confianza media declarada: ${avg}% · Basado en ${best.length} respuestas reales.*`;
  return out;
}

function agreementLevel(answers: RoundAnswer[]): "HIGH" | "MODERATE" | "LOW" {
  const agreeCount = answers.reduce((s, a) => s + a.agree_with.length, 0);
  if (agreeCount >= 4) return "HIGH";
  if (agreeCount >= 2) return "MODERATE";
  return "LOW";
}

export interface RunConsensusArgs {
  question: string;
  participants: AgentRuntime[];
  moderator: AgentRuntime;
  emit: (event: StreamEvent) => void;
  fetcher?: typeof fetch;
  /** Aborted when the client disconnects — in-flight LLM calls cancel immediately. */
  signal?: AbortSignal;
}

export async function runConsensus(args: RunConsensusArgs): Promise<ConsensusResult> {
  const { question, participants, moderator, emit, fetcher, signal } = args;
  const started = Date.now();

  emit({ type: "round", round: 1, status: "start" });
  const round1 = await Promise.all(
    participants.map(async (p) => {
      const outcome = await callParticipant(p, question, 1, null, fetcher, signal);
      emit({
        type: "agent",
        round: 1,
        agent_key: p.key,
        display_name: p.display_name,
        status: outcome.slot.status === "ok" ? "ok" : "error",
        confidence: outcome.slot.status === "ok" ? outcome.slot.data.confidence : undefined,
        duration_ms: outcome.elapsed_ms,
        error: outcome.slot.status === "error" ? outcome.slot.error : undefined,
      });
      return { agent: p, outcome };
    }),
  );
  emit({ type: "round", round: 1, status: "end" });

  const r1Ok = round1.filter((r) => r.outcome.slot.status === "ok");
  const r1Context = r1Ok.map((r) => ({
    name: r.agent.display_name,
    answer: r.outcome.slot.status === "ok" ? r.outcome.slot.data.answer : "",
  }));

  // Don't pay for round 2 if fewer than two participants survived round 1.
  if (r1Ok.length < 2) {
    throw new ConsensusError(
      "not_enough_participants",
      "Menos de 2 participantes respondieron; no se puede formar consenso.",
    );
  }

  emit({ type: "round", round: 2, status: "start" });
  const round2 = await Promise.all(
    participants.map(async (p) => {
      const outcome = await callParticipant(p, question, 2, r1Context, fetcher, signal);
      emit({
        type: "agent",
        round: 2,
        agent_key: p.key,
        display_name: p.display_name,
        status: outcome.slot.status === "ok" ? "ok" : "error",
        confidence: outcome.slot.status === "ok" ? outcome.slot.data.confidence : undefined,
        duration_ms: outcome.elapsed_ms,
        error: outcome.slot.status === "error" ? outcome.slot.error : undefined,
      });
      return { agent: p, outcome };
    }),
  );
  emit({ type: "round", round: 2, status: "end" });

  // Latest-good answer per participant (round 2 preferred, round 1 as backup).
  const latestOk = participants.map((p) => {
    const r1 = round1.find((r) => r.agent.key === p.key);
    const r2 = round2.find((r) => r.agent.key === p.key);
    const slot: RoundSlot | undefined =
      r2?.outcome.slot.status === "ok"
        ? r2.outcome.slot
        : r1?.outcome.slot.status === "ok"
          ? r1.outcome.slot
          : undefined;
    return { agent: p, slot };
  });

  const alive = latestOk.filter((r) => r.slot !== undefined);
  if (alive.length < 2) {
    throw new ConsensusError(
      "not_enough_participants",
      "Menos de 2 participantes respondieron; no se puede formar consenso.",
    );
  }

  const moderatorInput = alive.map((r) => ({
    name: r.agent.display_name,
    confidence: r.slot?.status === "ok" ? r.slot.data.confidence : 0,
    answer: r.slot?.status === "ok" ? r.slot.data.answer : "",
    keyPoints: r.slot?.status === "ok" ? r.slot.data.key_points : [],
  }));

  if (signal?.aborted) {
    throw new ConsensusError("aborted", "Proceso cancelado por el usuario.");
  }
  emit({ type: "moderation", status: "start" });
  const moderation = await callModerator(moderator, question, moderatorInput, fetcher, signal);
  // The abort may land DURING the moderator call: without this check a
  // fallback synthesis would be produced and cached as if it were real.
  if (signal?.aborted) {
    throw new ConsensusError("aborted", "Proceso cancelado por el usuario.");
  }

  let consensus: string;
  let moderatorFallback = false;
  if ("error" in moderation) {
    moderatorFallback = true;
    consensus = fallbackSynthesis(
      question,
      moderatorInput,
      moderator.display_name,
      moderation.error,
    );
  } else {
    consensus = moderation.text;
  }
  emit({
    type: "moderation",
    status: "end",
    duration_ms: moderation.elapsed_ms,
    fallback: moderatorFallback,
  });

  const participantResults: ParticipantResult[] = participants.map((p) => {
    const r1 = round1.find((r) => r.agent.key === p.key);
    const r2 = round2.find((r) => r.agent.key === p.key);
    const slots: [RoundSlot, RoundSlot] = [
      r1?.outcome.slot ?? { status: "error", error: "no ejecutado" },
      r2?.outcome.slot ?? { status: "error", error: "no ejecutado" },
    ];
    const errOf = (s: RoundSlot | undefined): string | null =>
      s && s.status === "error" ? s.error : null;
    const unavailable = slots.every((s) => s.status === "error");
    return {
      key: p.key,
      display_name: p.display_name,
      rounds: slots,
      unavailable,
      error: unavailable ? (errOf(slots[1]) ?? errOf(slots[0])) : null,
    };
  });

  const okAnswers = alive
    .map((r) => (r.slot?.status === "ok" ? r.slot.data : null))
    .filter((d): d is RoundAnswer => d !== null);
  const avgConfidence =
    okAnswers.length > 0
      ? Math.round(okAnswers.reduce((s, a) => s + a.confidence, 0) / okAnswers.length)
      : 0;

  return {
    question,
    consensus,
    moderator_key: moderator.key,
    moderator_fallback: moderatorFallback,
    degraded: alive.length < participants.length || moderatorFallback,
    participants: participantResults,
    unavailable_agents: participantResults.filter((p) => p.unavailable).map((p) => p.display_name),
    metrics: {
      confidence: avgConfidence,
      agreement_level: agreementLevel(okAnswers),
      processing_time_s: Math.round(((Date.now() - started) / 1000) * 10) / 10,
      agents_ok: alive.length,
      agents_total: participants.length,
    },
    from_cache: false,
  };
}

// ---------------------------------------------------------------------------
// Individual query
// ---------------------------------------------------------------------------

export async function runIndividual(args: {
  question: string;
  agent: AgentRuntime;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{
  answer: string;
  key_points: string[];
  concerns: string[];
  confidence: number;
}> {
  const res = await callChatCompletion({
    url: args.agent.url,
    model: args.agent.model,
    apiKey: args.agent.api_key,
    messages: [
      { role: "system", content: buildIndividualSystemPrompt(args.agent.name) },
      { role: "user", content: `Pregunta: ${args.question}` },
    ],
    temperature: 0.85,
    timeoutS: args.agent.timeout_s,
    fetcher: args.fetcher,
    signal: args.signal,
  });

  if (res.error || res.content === null) {
    const err = res.error ?? { message: "Respuesta vacía", detail: "" };
    // Status class only — upstream response bodies stay on the server.
    throw new ConsensusError("agent_failed", err.message);
  }

  const extracted = extractAgentOutput(res.content);
  if (!extracted.ok)
    throw new ConsensusError("agent_failed", "La API devolvió una respuesta vacía");

  return {
    answer: extracted.data.answer,
    key_points: extracted.data.key_points,
    concerns: extracted.data.concerns,
    confidence: extracted.data.confidence,
  };
}
