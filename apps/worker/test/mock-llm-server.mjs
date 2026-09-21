/**
 * Mock OpenAI-compatible LLM server for local dev & E2E.
 * Serves POST /v1/chat/completions on :8790. Models starting with
 * "demo-moderator" answer as the moderator (plain text); others answer as
 * experts (JSON participant format). "?fail=<model>" behavior is controlled
 * by the model name: any model containing "fail" returns 500.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8790);

function expertJson(model, round2) {
  return JSON.stringify({
    agent_id: model,
    confidence: round2 ? 87 : 81,
    answer: `Análisis del experto ${model}. Este es un texto de prueba suficientemente largo con estructura: ## Marco\nDefinimos los conceptos clave del tema consultado.\n## Plan\n1. Primer paso accionable. 2. Segundo paso. 3. Tercer paso.\n## Ejemplos\n- Ejemplo práctico uno\n- Ejemplo práctico dos\n\nEn conclusión, la estrategia combina los puntos anteriores con criterio técnico y limitaciones claras. `,
    key_points: [`${model}: punto clave A`, `${model}: punto clave B`],
    concerns: [`${model}: limitación de prueba`],
    agree_with: round2 ? [model] : [],
  });
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mock: true }));
    return;
  }
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    let model = "unknown";
    let round2 = false;
    try {
      const parsed = JSON.parse(body);
      model = parsed.model ?? "unknown";
      round2 = (parsed.messages ?? []).some(
        (m) =>
          String(m.content).includes("RONDA 2") ||
          String(m.content).includes("Respuestas de otros expertos"),
      );
    } catch {
      /* fallthrough */
    }
    // Slow-response simulation for timeout testing.
    if (model.includes("slow")) {
      setTimeout(() => res.writeHead(500).end("slow"), 30_000);
      return;
    }
    if (model.includes("fail")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `mock failure for ${model}` } }));
      return;
    }
    const content = model.startsWith("demo-moderator")
      ? "# Respuesta consensuada\n\n## Marco\nLos tres expertos coinciden en el enfoque general.\n\n## Plan\n1. Paso uno priorizado.\n2. Paso dos.\n\n## Riesgos\n- Riesgo principal y mitigación.\n\n*Generado por el servidor mock.*"
      : expertJson(model, round2);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
  });
});

server.listen(PORT, () =>
  console.log(`🤖 Mock LLM server → http://127.0.0.1:${PORT}/v1/chat/completions`),
);
