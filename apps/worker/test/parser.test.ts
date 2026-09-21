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
