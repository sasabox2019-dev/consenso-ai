/**
 * Robust extraction of the structured JSON participant output from raw LLM text.
 * LLMs wrap JSON in prose/markdown fences, emit control characters inside
 * string literals, or use single quotes — all handled here before Zod validates.
 */
import { type AgentOutput, agentOutputSchema } from "@consenso/shared";

function stripCodeFences(text: string): string {
  return text
    .replace(/```(?:json|javascript|python)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

function tryParse(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    /* next strategy */
  }
  // Escape raw control characters that are illegal inside JSON string literals.
  try {
    const sanitized = candidate.replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
    return JSON.parse(sanitized);
  } catch {
    /* next strategy */
  }
  // Single-quoted strings → double quotes (lossy last resort).
  try {
    return JSON.parse(candidate.replace(/'/g, '"'));
  } catch {
    /* regex salvage */
  }
  return null;
}

function regexSalvage(candidate: string): unknown | null {
  const answer = candidate.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/s)?.[1];
  if (!answer) return null;
  const confidenceRaw = candidate.match(/"confidence"\s*:\s*(\d+(?:\.\d+)?)/)?.[1];
  const keyPoints = candidate.match(/"key_points"\s*:\s*\[(.*?)\]/s)?.[1];
  const concerns = candidate.match(/"concerns"\s*:\s*\[(.*?)\]/s)?.[1];
  const parseList = (raw: string | undefined): string[] =>
    raw
      ? raw
          .split(/","/)
          .map((s) => s.replace(/^"|"$/g, "").trim())
          .filter((s) => s.length > 0)
      : [];
  return {
    answer,
    confidence: confidenceRaw !== undefined ? Number(confidenceRaw) : 75,
    key_points: parseList(keyPoints),
    concerns: parseList(concerns),
    agree_with: [],
  };
}

export type ExtractionResult =
  | { ok: true; data: AgentOutput; usedFallback: false }
  | { ok: true; data: AgentOutput; usedFallback: true }
  | { ok: false };

/**
 * Returns a structured AgentOutput or wraps the raw text as a fallback answer
 * (confidence 70, no key points) when no JSON can be recovered. `ok: false`
 * only happens when the raw text is empty — there is nothing to show.
 */
export function extractAgentOutput(raw: string): ExtractionResult {
  const cleaned = stripCodeFences(raw ?? "");
  if (cleaned.trim().length === 0) return { ok: false };

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const candidate = cleaned.slice(start, end + 1);
    const parsed = tryParse(candidate) ?? regexSalvage(candidate);
    if (parsed && typeof parsed === "object") {
      const validated = agentOutputSchema.safeParse(parsed);
      if (validated.success && validated.data.answer.trim().length > 0) {
        return { ok: true, data: validated.data, usedFallback: false };
      }
    }
  }

  // No usable JSON: keep the raw text so the user still sees the real answer.
  return {
    ok: true,
    usedFallback: true,
    data: {
      confidence: 70,
      answer: cleaned.slice(0, 4000),
      key_points: [],
      concerns: ["respuesta-sin-formato-json"],
      agree_with: [],
    },
  };
}
