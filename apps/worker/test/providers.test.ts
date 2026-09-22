import { describe, expect, it } from "vitest";
import { callChatCompletion, normalizeContent } from "../src/core/providers";

function okResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("normalizeContent", () => {
  it("extracts OpenAI-style choices[0].message.content", () => {
    expect(
      normalizeContent({ choices: [{ message: { role: "assistant", content: "hola" } }] }),
    ).toBe("hola");
  });

  it("extracts content-block arrays (Cohere v2 style)", () => {
    expect(normalizeContent({ message: { content: [{ type: "text", text: "bloque" }] } })).toBe(
      "bloque",
    );
  });

  it("extracts choice.text (legacy completion style)", () => {
    expect(normalizeContent({ choices: [{ text: "legacy" }] })).toBe("legacy");
  });

  it("extracts content[0].text (minimal gateways)", () => {
    expect(normalizeContent({ content: [{ text: "min" }] })).toBe("min");
  });

  it("returns null for unknown shapes", () => {
    expect(normalizeContent({})).toBe(null);
    expect(normalizeContent(null)).toBe(null);
  });
});

describe("callChatCompletion", () => {
  const base = {
    url: "https://api.example.com/v1/chat/completions",
    model: "test-model",
    apiKey: "sk-test",
    messages: [{ role: "user" as const, content: "hi" }],
    temperature: 0.5,
    timeoutS: 5,
  };

  it("returns content on success", async () => {
    const fetcher = async () => okResponse({ choices: [{ message: { content: "respuesta" } }] });
    const r = await callChatCompletion({ ...base, fetcher: fetcher as typeof fetch, retries: 0 });
    expect(r.error).toBe(null);
    expect(r.content).toBe("respuesta");
  });

  it("retries 429 with Retry-After and succeeds", async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls++;
      if (calls === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0.01" } });
      }
      return okResponse({ choices: [{ message: { content: "ok" } }] });
    };
    const r = await callChatCompletion({
      ...base,
      fetcher: fetcher as typeof fetch,
      retries: 2,
      retryDelaysMs: [1],
    });
    expect(calls).toBe(2);
    expect(r.content).toBe("ok");
  });

  it("does NOT retry non-retryable HTTP errors (401)", async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls++;
      return new Response("bad key", { status: 401 });
    };
    const r = await callChatCompletion({ ...base, fetcher: fetcher as typeof fetch, retries: 3 });
    expect(calls).toBe(1);
    expect(r.error?.type).toBe("http_error");
    expect(r.error?.status).toBe(401);
  });

  it("retries 503 then gives up with error", async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls++;
      return new Response("cold start", { status: 503 });
    };
    const r = await callChatCompletion({
      ...base,
      fetcher: fetcher as typeof fetch,
      retries: 1,
      retryDelaysMs: [1],
    });
    expect(calls).toBe(2);
    expect(r.content).toBe(null);
    expect(r.error?.status).toBe(503);
  });

  it("classifies timeouts", async () => {
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      // Simulate hanging request aborted by signal.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    };
    const r = await callChatCompletion({
      ...base,
      timeoutS: 1,
      fetcher: fetcher as typeof fetch,
      retries: 0,
    });
    expect(r.error?.type).toBe("timeout");
  });

  it("treats 200 with unusable body as parse_error", async () => {
    const fetcher = async () => new Response("not json", { status: 200 });
    const r = await callChatCompletion({ ...base, fetcher: fetcher as typeof fetch, retries: 0 });
    expect(r.error?.type).toBe("parse_error");
  });

  it("treats 200 with empty content as parse_error", async () => {
    const fetcher = async () => okResponse({ choices: [{ message: { content: "" } }] });
    const r = await callChatCompletion({ ...base, fetcher: fetcher as typeof fetch, retries: 0 });
    expect(r.error?.type).toBe("parse_error");
  });
});

describe("regression: audit provider fixes", () => {
  const base = {
    url: "https://api.example.com/v1/chat/completions",
    model: "test-model",
    apiKey: "sk-test",
    messages: [{ role: "user" as const, content: "hi" }],
    temperature: 0.5,
    timeoutS: 1,
  };

  it("does NOT retry timeouts (a timeout already consumed the full budget)", async () => {
    let calls = 0;
    const fetcher = (_url: string, init?: RequestInit): Promise<Response> => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    };
    const r = await callChatCompletion({ ...base, fetcher: fetcher as typeof fetch, retries: 2 });
    expect(calls).toBe(1);
    expect(r.error?.type).toBe("timeout");
  });

  it("aborts immediately when the external signal fires (client disconnect)", async () => {
    let calls = 0;
    const fetcher = (_url: string, init?: RequestInit): Promise<Response> => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    };
    const controller = new AbortController();
    const pending = callChatCompletion({
      ...base,
      fetcher: fetcher as typeof fetch,
      retries: 3,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const r = await pending;
    expect(calls).toBe(1);
    expect(r.content).toBe(null);
  });
});
