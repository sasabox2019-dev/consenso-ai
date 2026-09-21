# Consenso AI v2

**Tres IAs expertas responden de forma independiente, se critican entre sí en una segunda ronda y una moderadora sintetiza una única respuesta superior.**

Reconstrucción completa desde cero, con seguridad reforzada, del proyecto "Sistema de Consenso Multi-IA", diseñado para funcionar íntegramente en el tier gratuito de Cloudflare. [English](README.md) · [Guía de despliegue](DEPLOY.md)

## Cómo funciona

```
Tu pregunta
     │
     ▼
 Ronda 1 ── 3 IAs expertas responden INDEPENDIENTE y en paralelo, en JSON estricto
     │       (confianza, respuesta, puntos clave, limitaciones, acuerdos)
     ▼
 Ronda 2 ── cada experta ve las respuestas de las demás (resumidas),
     │       corrige errores, integra lo mejor de cada una y vuelve a responder
     ▼
 Moderadora ─ una IA lee todas las respuestas de la ronda 2 y redacta la
     │         respuesta final consensuada (500+ palabras, sin revelar participantes)
     ▼
 Respuesta + métricas (confianza, nivel de acuerdo, tiempo) + vista del proceso
```

Todo puede fallar de forma segura: un proveedor con error o sin API key se muestra como *no disponible* (nunca se inventa contenido); si la moderadora falla, se muestra una síntesis local claramente etiquetada; el consenso requiere al menos 2 participantes vivos.

## Funcionalidades

- **Cualquier proveedor compatible con OpenAI**: Groq, OpenRouter, DeepSeek, Mistral, Together, router de HuggingFace o cualquier URL propia — configurable desde el panel admin en caliente.
- **UI tipo centro de control en vivo**: streaming SSE muestra cada ronda, el estado por agente, confianza y latencia mientras ocurre. Bilingüe ES/EN con un clic.
- **Panel de administración**: bootstrap del primer arranque, CRUD de agentes, API keys de solo escritura (cifradas con AES-256-GCM), prueba de conexión en vivo, cambio de contraseña, registro de auditoría.
- **Seguridad**: cookies de sesión HttpOnly SameSite=Strict, revocación de sesiones en el servidor al cerrar sesión o cambiar contraseña, hash de contraseña con HMAC y pepper, validación Zod en toda entrada, rate limiting en D1 (login + APIs), cabeceras de seguridad estrictas, sin CORS (mismo origen), sin secretos en el código ni en el repo.
- **Parseo robusto de salidas LLM**: fences de markdown, caracteres de control, comillas simples, rescate por regex — y fallback a texto plano para no perder nunca una respuesta.

## Stack

TypeScript de punta a punta · Hono (API) · React + Vite + Tailwind (UI) · Cloudflare Workers + D1 (hosting/BD) · Vitest (54 tests) + E2E scripted (30 comprobaciones) · Biome · GitHub Actions.

> **Desarrollo local en macOS ≤ 13.4**: el runtime de Workers (workerd) no funciona ahí, así que este repo incluye un runtime local equivalente: la misma app Hono servida por Node con un adaptador D1 sobre `node:sqlite`. Los tests y el E2E corren sobre él; en producción se despliega el mismo código a Cloudflare sin cambios.

## Inicio rápido (local, sin cuenta de Cloudflare)

```bash
npm install
npm run build            # compila la UI
npm run e2e              # E2E autocontenido: LLM mock + app + 30 comprobaciones
npm run dev              # http://localhost:8787 con 4 agentes demo + LLM mock
# en otra terminal:
node apps/worker/test/mock-llm-server.mjs   # para la demo con UI
# abre http://localhost:8787 → #/admin → crea el admin → gestiona agentes
```

`npm run dev` genera `.dev-vars.json` (secretos locales aleatorios, en gitignore) e inserta 4 agentes demo apuntando al servidor LLM mock: el producto entero funciona sin ninguna API key real.

Para usar proveedores reales: arranca la app, entra en `#/admin`, crea la cuenta admin y añade tus agentes con sus API keys — o despliega y haz lo mismo en tu dominio.

## Despliegue (tier gratuito)

Ver [DEPLOY.md](DEPLOY.md) — en resumen: `wrangler login` → crear D1 → aplicar migraciones → 2 secretos → `npm run deploy`. Todo (API + UI) se publica como un único Worker con assets estáticos.

## Encaje en el tier gratuito

| Recurso | Límite gratis | Esta app |
|---|---|---|
| Peticiones Worker | 100k/día | Los assets estáticos no cuentan; la API recibe una llamada por acción |
| CPU | 10 ms/petición | Las llamadas LLM son esperas de red, no CPU |
| Filas D1 leídas/escritas | 5M / 100k por día | Una sesión de consenso completa usa un puñado de filas |

## Estructura del repo

```
packages/shared    Esquemas Zod + tipos compartidos por API y UI
apps/worker        API Hono, motor de consenso, crypto, auth, capa D1,
                   runtime Node para desarrollo, migraciones, tests, E2E
apps/web           UI React centro de control (se compila dentro del Worker)
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor Node (API + UI compilada) con agentes demo |
| `npm run dev:web` | Vite con hot reload (proxifica `/api` a :8787) |
| `npm run build` | Compila la UI en `apps/worker/public` |
| `npm test` | 54 tests unitarios + integración (app real, LLM mock) |
| `npm run e2e` | Arranca LLM mock + servidor, 30 comprobaciones E2E |
| `npm run lint` / `lint:fix` | Biome |
| `npm run deploy` | Build + `wrangler deploy` |

## Licencia

MIT
