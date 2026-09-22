/**
 * Single OpenAI-compatible chat-completions transport.
 *
 * Works with Groq, OpenRouter, DeepSeek, Mistral, Together, HuggingFace router,
 * and any custom endpoint speaking the same dialect. Response normalization
 * accepts `content` as a plain string OR as an array of content blocks —
 * several gateways (and Cohere v2) return the block form.
 */
import { LIMITS } from "@consenso/shared";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface LLMError {
  type: "http_error" | "timeout" | "connection_error" | "parse_error" | "empty";
  status: number;
  message: string;
  detail: string;
}

export interface LLMCallResult {
  content: string | null;
  elapsed_ms: number;
  error: LLMError | null;
}

export interface LLMCallArgs {
  url: string;
  model: string;
  apiKey: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens?: number;
  timeoutS: number;
  retries?: number;
  /** Test hook: overrides backoff delays (ms) between retries. */
  retryDelaysMs?: number[];
  /** External abort (e.g. client disconnected) — combined with the per-call timeout. */
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

function parseRetryAfterMs(res: Response): number | null {
  const ra = res.headers.get("retry-after");
  if (!ra) return null;
  const seconds = Number(ra);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 30) * 1000;
  const date = Date.parse(ra);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  return null;
}

/** Normalizes the many shapes of "assistant message content". */
export function normalizeContent(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;

  const fromMessage = (msg: unknown): string | null => {
    if (typeof msg !== "object" || msg === null) return null;
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) => {
          if (typeof block === "string") return block;
          if (typeof block === "object" && block !== null) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") return b.text;
          }
          return "";
        })
        .join("")
        .trim();
      return text.length > 0 ? text : null;
    }
    return null;
  };

  // OpenAI-compatible: choices[0].message.content
  if (Array.isArray(d.choices) && d.choices.length > 0) {
    const choice = d.choices[0] as Record<string, unknown>;
    const msg = fromMessage(choice.message);
    if (msg !== null) return msg;
    // Some dialects put text directly on the choice.
    if (typeof choice.text === "string" && choice.text.length > 0) return choice.text;
  }

  // Cohere v2 style: message.content (string or block array)
  if (d.message !== undefined) {
    const msg = fromMessage(d.message);
    if (msg !== null) return msg;
  }

  // Minimal gateways: content[0].text
  if (Array.isArray(d.content) && d.content.length > 0) {
    const first = d.content[0] as Record<string, unknown>;
    if (typeof first?.text === "string") return first.text;
  }

  return null;
}

export async function callChatCompletion(args: LLMCallArgs): Promise<LLMCallResult> {
  const doFetch = args.fetcher ?? fetch;
  const retries = args.retries ?? LIMITS.LLM_RETRIES;
  const payload = {
    model: args.model,
    messages: args.messages,
    temperature: args.temperature,
    max_tokens: args.maxTokens ?? LIMITS.LLM_MAX_TOKENS,
  };
  const headers = {
    authorization: `Bearer ${args.apiKey}`,
    "content-type": "application/json",
  };

  const started = Date.now();
  let lastError: LLMError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeoutSignal = AbortSignal.timeout(args.timeoutS * 1000);
    const signal = args.signal ? AbortSignal.any([timeoutSignal, args.signal]) : timeoutSignal;
    try {
      const res = await doFetch(args.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });

      if (res.ok) {
        const text = await res.text();
        try {
          const content = normalizeContent(JSON.parse(text));
          if (content === null || content.trim().length === 0) {
            lastError = {
              type: "parse_error",
              status: 200,
              message: "La API respondió sin contenido utilizable",
              detail: text.slice(0, 300),
            };
          } else {
            return { content, elapsed_ms: Date.now() - started, error: null };
          }
        } catch (e) {
          lastError = {
            type: "parse_error",
            status: 200,
            message: "La API respondió con JSON inválido",
            detail: text.slice(0, 300),
          };
        }
      } else {
        const body = await res.text();
        lastError = {
          type: "http_error",
          status: res.status,
          message: `HTTP ${res.status}`,
          detail: body.slice(0, 300),
        };
        // Retry only on rate limit / transient server errors.
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const delay =
            parseRetryAfterMs(res) ?? args.retryDelaysMs?.[attempt] ?? 1000 * 2 ** attempt;
          await sleep(delay);
          continue;
        }
        break; // non-retryable HTTP error (e.g. 401/403/404)
      }
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === "TimeoutError";
      const isAbort = e instanceof Error && (e.name === "AbortError" || isTimeout);
      lastError = isTimeout
        ? {
            type: "timeout",
            status: 408,
            message: `Sin respuesta en ${args.timeoutS}s`,
            detail: "La API no respondió dentro del timeout configurado",
          }
        : isAbort
          ? {
              type: "timeout",
              status: 499,
              message: "Llamada cancelada",
              detail: "El cliente abortó la petición",
            }
          : {
              type: "connection_error",
              status: 0,
              message: "Error de conexión con la API",
              detail: String(e).slice(0, 300),
            };
      // A timeout already consumed the full budget and a client abort means
      // nobody is listening — never burn another attempt on either.
      if (isAbort) break;
      if (attempt < retries) {
        await sleep(args.retryDelaysMs?.[attempt] ?? 1000 * 2 ** attempt);
        continue;
      }
    }
    if (attempt < retries && lastError?.type === "parse_error") {
      // A 200 with unusable body is not worth retrying.
      break;
    }
  }

  return { content: null, elapsed_ms: Date.now() - started, error: lastError };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
