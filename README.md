# Consenso AI v2

**Three AI experts answer independently, critique each other in a second round, and a moderator AI synthesizes one superior consensus answer.**

This is a from-scratch, security-hardened rebuild of the "Sistema de Consenso Multi-IA" project, designed to run entirely on Cloudflare's free tier. [Español](README.es.md) · [Deployment guide](DEPLOY.md)

## How it works

```
Your question
     │
     ▼
 Round 1 ── 3 AI experts answer INDEPENDENTLY, in parallel, in strict JSON
     │       (confidence, answer, key_points, concerns, agree_with)
     ▼
 Round 2 ── each expert sees the others' answers (summarized),
     │       corrects errors, integrates the best of each, re-answers
     ▼
 Moderator ─ one AI reads all round-2 answers and writes the final
     │        500+ word consensus (never revealing the participants)
     ▼
 Answer + metrics (confidence, agreement level, timing) + full process view
```

Anything can fail safely: a provider that errors or lacks a key is reported as *unavailable* (never faked); if the moderator fails, a clearly-labeled local synthesis is shown; consensus needs at least 2 live participants.

## Features

- **Any OpenAI-compatible provider**: Groq, OpenRouter, DeepSeek, Mistral, Together, HuggingFace router, or any custom base URL — configured at runtime from the admin panel.
- **Live mission-control UI**: SSE streaming shows each round, per-agent status, confidence and latency while it happens. Bilingual ES/EN with one-click toggle.
- **Admin panel**: first-run bootstrap, agent CRUD, write-only API keys (AES-256-GCM encrypted at rest), live connection tests, password rotation, audit log.
- **Security**: HttpOnly SameSite=Strict session cookies, server-side session revocation on logout/password change, peppered HMAC password hashing, Zod validation on every input, D1-backed rate limiting (login + APIs), strict security headers, no CORS (same origin), no secrets in code or repo.
- **Robust LLM output parsing**: markdown fences, control chars, single quotes, regex salvage — plus a raw-text fallback so an answer is never lost.

## Stack

TypeScript end to end · Hono (API) · React + Vite + Tailwind (UI) · Cloudflare Workers + D1 (hosting/DB) · Vitest (81 tests) + scripted E2E (30 checks) · Biome · GitHub Actions.

> **Local development on macOS ≤ 13.4**: the Workers runtime (workerd) does not run there, so this repo ships an equivalent local runtime: the same Hono app served over Node with a `node:sqlite` D1 shim. Tests and E2E run on it; production deploys the identical code to Cloudflare.

## Quick start (local, no Cloudflare account needed)

```bash
npm install
npm run build            # builds the web UI
npm run e2e              # self-contained E2E: mock LLM + app + 30 checks
npm run dev              # http://localhost:8787 with 4 demo agents + mock LLM
# in another terminal:
node apps/worker/test/mock-llm-server.mjs   # if you want the UI demo too
# open http://localhost:8787 → #/admin → create admin → manage agents
```

`npm run dev` generates `.dev-vars.json` (random local secrets, gitignored) and seeds 4 demo agents pointing at the mock LLM server, so the whole product works with zero API keys.

To use real providers: start the app (`npm run dev`), open `#/admin`, create the admin account, and add your agents with real API keys — or deploy and do the same on your domain.

## Deploy (free tier)

See [DEPLOY.md](DEPLOY.md) — roughly: `wrangler login` → create D1 → apply migrations → set 2 secrets → `npm run deploy`. Everything (API + UI) ships as one Worker with static assets.

## Free-tier fit

| Resource | Free limit | This app |
|---|---|---|
| Worker requests | 100k/day | Static assets don't count; API calls are one per user action |
| CPU time | 10 ms/req | LLM calls are network waits, not CPU |
| D1 rows read/written | 5M / 100k per day | A full consensus session uses a handful of rows |

## Repository layout

```
packages/shared    Zod schemas + types shared by API and UI
apps/worker        Hono API, consensus engine, crypto, auth, D1 layer,
                   node dev runtime, migrations, tests, E2E
apps/web           React mission-control UI (builds into the Worker)
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Node dev server (API + built UI) with seeded demo agents |
| `npm run dev:web` | Vite dev server with hot reload (proxies `/api` to :8787) |
| `npm run build` | Build the UI into `apps/worker/public` |
| `npm test` | 81 unit + integration tests (real app, mocked LLM) |
| `npm run e2e` | Boots mock LLM + server, runs 30 end-to-end checks |
| `npm run lint` / `lint:fix` | Biome |
| `npm run deploy` | Build + `wrangler deploy` |

## License

MIT
