import { describe, expect, it } from "vitest";
import { extractAgentOutput } from "../src/core/parser";

const good = JSON.stringify({
  agent_id: "Agent_X",
  confidence: 88,
  answer: "Respuesta profunda y completa.".repeat(20),
  key_points: ["punto A", "punto B"],
  concerns: ["limitación 1"],
  agree_with: ["Agent_Y"],
});

describe("extractAgentOutput", () => {
  it("parses clean JSON", () => {
    const r = extractAgentOutput(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.usedFallback).toBe(false);
      expect(r.data.confidence).toBe(88);
      expect(r.data.key_points).toHaveLength(2);
    }
  });

  it("parses JSON wrapped in markdown fences", () => {
    const r = extractAgentOutput(`\`\`\`json\n${good}\n\`\`\``);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usedFallback).toBe(false);
  });

  it("parses JSON with surrounding prose", () => {
    const r = extractAgentOutput(`Aquí tienes mi análisis:\n${good}\nUn saludo.`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.key_points).toHaveLength(2);
  });

  it("parses JSON with raw newlines inside strings (LLM common failure)", () => {
    const broken =
      '{"agent_id":"A","confidence":80,"answer":"línea 1\nlínea 2\nlínea 3","key_points":[],"concerns":[],"agree_with":[]}';
    const r = extractAgentOutput(broken);
    expect(r.ok).toBe(true);
    if (r.ok && !r.usedFallback) {
      expect(r.data.answer).toContain("línea 2");
    }
  });

  it("recovers via regex salvage when JSON is hopeless", () => {
    const hopeless =
      'blah {"answer":"texto con \\"comillas\\" dentro","confidence":77,"key_points":["x"]} blah';
    const r = extractAgentOutput(hopeless);
    expect(r.ok).toBe(true);
  });

  it("falls back to raw text when no JSON at all", () => {
    const r = extractAgentOutput("Esto es texto plano largo sin ningún JSON. ".repeat(10));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.usedFallback).toBe(true);
      expect(r.data.answer).toContain("texto plano");
      expect(r.data.confidence).toBe(70);
    }
  });

  it("clamps out-of-range confidence", () => {
    const r = extractAgentOutput('{"confidence":500,"answer":"x"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.confidence).toBe(100);
  });

  it("coerces numeric-string confidence", () => {
    const r = extractAgentOutput('{"confidence":"64","answer":"x"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.confidence).toBe(64);
  });

  it("fails only on empty input", () => {
    expect(extractAgentOutput("").ok).toBe(false);
    expect(extractAgentOutput("   ").ok).toBe(false);
  });
});

describe("regression: audit parser fixes", () => {
  it("preserves code fences INSIDE the answer (only strips a wrapping fence)", () => {
    const inner = "Aquí va código:\\n```python\\nprint('hola')\\n```\\nFin.";
    const payload = JSON.stringify({
      agent_id: "A",
      confidence: 80,
      answer: inner,
      key_points: [],
      concerns: [],
      agree_with: [],
    });
    const r = extractAgentOutput(`\`\`\`json\\n${payload}\\n\`\`\``);
    expect(r.ok).toBe(true);
    if (r.ok && !r.usedFallback) {
      expect(r.data.answer).toContain("```python");
    } else {
      throw new Error("should have parsed as JSON");
    }
  });

  it("still parses pretty-printed JSON (newlines between tokens)", () => {
    const pretty =
      '{\\n  "agent_id": "A",\\n  "confidence": 77,\\n  "answer": "Respuesta completa con líneas internas",\\n  "key_points": [],\\n  "concerns": [],\\n  "agree_with": []\\n}';
    const r = extractAgentOutput(pretty);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.confidence).toBe(77);
  });

  it("unescape escape sequences in regex-salvaged answers", () => {
    const hopeless = '{"answer":"línea 1\\\\nlínea 2","confidence":66}';
    const r = extractAgentOutput(`texto roto ${hopeless} más texto`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.answer).toContain("línea 1\\nlínea 2");
    }
  });

  it("no longer injects the magic marker concern in fallback answers", () => {
    const r = extractAgentOutput(
      "Respuesta en texto plano sin JSON alguno, suficientemente larga. ".repeat(5),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.concerns).not.toContain("respuesta-sin-formato-json");
  });

  it("keeps apostrophes intact when handling single-quoted JSON", () => {
    const r = extractAgentOutput("{'answer': \"it's fine to keep\", 'confidence': 70}");
    expect(r.ok).toBe(true);
    if (r.ok && !r.usedFallback) {
      expect(r.data.answer).toContain("it's fine");
    }
  });
});

describe("regression: second-audit parser fixes", () => {
  it("parses a fence with language but NO newline after it (was: destroyed payload)", () => {
    const payload = JSON.stringify({
      agent_id: "A",
      confidence: 80,
      answer: "respuesta válida",
      key_points: [],
      concerns: [],
      agree_with: [],
    });
    const r = extractAgentOutput(`\`\`\`json${payload}\n\`\`\``);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.answer).toBe("respuesta válida");
  });

  it("leaves multi-codeblock payloads untouched (no mangling)", () => {
    const multi = "```\nA\n```\ntext\n```\nB\n```";
    const r = extractAgentOutput(multi);
    expect(r.ok).toBe(true);
    if (r.ok && r.usedFallback) {
      expect(r.data.answer).toContain("A\n```\ntext\n```\nB");
    } else {
      throw new Error("should be raw fallback, not mangled parse");
    }
  });

  it("escapes ALL control characters inside strings (NUL etc.), not just \\n\\r\\t", () => {
    const payload =
      '{"agent_id":"A","confidence":80,"answer":"a\u0000b","key_points":[],"concerns":[],"agree_with":[]}';
    const r = extractAgentOutput(payload);
    expect(r.ok).toBe(true);
    if (r.ok && !r.usedFallback) {
      expect(r.data.answer).toContain("a");
      expect(r.data.answer).toContain("b");
    } else {
      throw new Error("control-char sanitization failed");
    }
  });

  it("survives unescaped double quotes inside single-quoted JSON", () => {
    const r = extractAgentOutput("{'answer': 'say \"hi\" now please', 'confidence': 70}");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.answer).toContain("hi");
      expect(r.data.answer).toContain("now please");
    }
  });
});
