/**
 * Robust extraction of the structured JSON participant output from raw LLM text.
 * LLMs wrap JSON in prose/markdown fences, emit control characters inside
 * string literals, or use single quotes — all handled here before Zod validates.
 */
import { type AgentOutput, agentOutputSchema } from "@consenso/shared";

/**
 * Strips a code fence only when it WRAPS the whole payload. Fences that appear
 * inside the answer (e.g. a coding question whose answer contains ``` blocks)
 * must survive untouched — ambiguous payloads are left as-is, because the
 * JSON extraction (first "{" … last "}") handles prose-wrapped payloads anyway.
 */
function stripWrappingFence(text: string): string {
  const trimmed = text.trim();
  // Path 1: "```lang\n…\n```" (newline after the language tag).
  const wrapped = trimmed.match(/^```[a-zA-Z0-9_-]*[ \t]*\n([\s\S]*?)\n?[ \t]*```$/);
  if (wrapped?.[1] !== undefined && !wrapped[1].includes("```")) return wrapped[1].trim();
  // Path 2: starts and ends with fences but no newline after the language —
  // "```json{…}\n```". Only strip when what follows "```" is a bare language
  // tag; otherwise the payload is ambiguous (multiple code blocks) and any
  // slicing would corrupt it.
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const inner = trimmed.slice(3, -3);
    const firstNewline = inner.indexOf("\n");
    const head = firstNewline === -1 ? inner : inner.slice(0, firstNewline);
    if (/^[a-zA-Z0-9_-]*$/.test(head)) {
      const body = firstNewline === -1 ? "" : inner.slice(firstNewline + 1);
      if (!body.includes("```")) return body.trim();
    }
  }
  return trimmed;
}

/** Escapes ALL raw control characters (C0) inside JSON string literals. */
function escapeControlsInStrings(candidate: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of candidate) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (inString && code < 0x20) {
      out +=
        ch === "\n"
          ? "\\n"
          : ch === "\r"
            ? "\\r"
            : ch === "\t"
              ? "\\t"
              : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Converts single-quoted JSON strings to double quotes, preserving apostrophes. */
function singleToDoubleQuotes(candidate: string): string {
  let out = "";
  let inString = false;
  let stringChar = "";
  let escaped = false;
  for (const ch of candidate) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\" && stringChar === '"') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        out += '"';
        continue;
      }
      // Inside the new double-quoted string, both apostrophes (content) and
      // previously-unescaped double quotes must be escaped to stay valid JSON.
      if (stringChar === "'" && ch === '"') {
        out += '\\"';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      out += '"';
      continue;
    }
    out += ch;
  }
  return out;
}

function tryParse(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    /* next strategy */
  }
  try {
    return JSON.parse(escapeControlsInStrings(candidate));
  } catch {
    /* next strategy */
  }
  try {
    return JSON.parse(singleToDoubleQuotes(candidate));
  } catch {
    /* regex salvage */
  }
  return null;
}

/** Unescapes a captured JSON string literal; falls back to the raw capture. */
function unescapeJsonLiteral(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function regexSalvage(candidate: string): unknown | null {
  const answerRaw = candidate.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/s)?.[1];
  if (answerRaw === undefined) return null;
  const confidenceRaw = candidate.match(/"confidence"\s*:\s*(\d+(?:\.\d+)?)/)?.[1];
  const keyPoints = candidate.match(/"key_points"\s*:\s*\[(.*?)\]/s)?.[1];
  const concerns = candidate.match(/"concerns"\s*:\s*\[(.*?)\]/s)?.[1];
  const parseList = (raw: string | undefined): string[] =>
    raw
      ? raw
          .split(/","/)
          .map((s) => unescapeJsonLiteral(s.replace(/^"|"$/g, "")).trim())
          .filter((s) => s.length > 0)
      : [];
  return {
    answer: unescapeJsonLiteral(answerRaw),
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
  const cleaned = stripWrappingFence(raw ?? "");
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
      concerns: [],
      agree_with: [],
    },
  };
}
