# Deployment guide — Cloudflare free tier

One Worker ships the API and the UI together. Everything below is free.

> Prefer your own server or Docker? See [SELF-HOST.md](SELF-HOST.md) (Spanish) — the same code runs on any Node host.

## 0. Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- Node ≥ 22.13 and npm (the local runtime uses `node:sqlite`)
- `npx wrangler login` (opens a browser)

## 1. Create the D1 database

```bash
cd apps/worker
npx wrangler d1 create consenso-ai
```

Copy the `database_id` from the output into `wrangler.jsonc` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`).

## 2. Apply migrations

```bash
npx wrangler d1 migrations apply consenso-ai --remote
```

## 3. Set the two secrets

```bash
# 32+ random bytes, hex. Generate: openssl rand -hex 32
npx wrangler secret put MASTER_KEY
npx wrangler secret put JWT_SECRET
```

- `MASTER_KEY` encrypts provider API keys (AES-256-GCM) in D1. **If you lose it, stored keys cannot be recovered** (just re-enter them).
- `JWT_SECRET` signs admin sessions and peppers password hashes. Rotating it invalidates all sessions and requires re-entering the admin password (re-run bootstrap… actually see "Password notes").

Optional: `BOOTSTRAP_TOKEN` — if set, creating the admin account additionally requires this token (protects the bootstrap window on a public URL).

## 4. Deploy

From the repo root:

```bash
npm run deploy
```

This builds the UI into `apps/worker/public` and deploys Worker + assets. Your URL: `https://consenso-ai.<your-subdomain>.workers.dev`.

## 5. First run on the deployed URL

1. Open `https://…/workers.dev/#/admin`
2. "Primer arranque" / "First run" — create the admin account (use the *Generar / Generate* button or a password manager; minimum 12 chars)
3. Add your agents (role `Moderadora` for exactly one, e.g. Groq; the rest `Participante`)
   - URL examples: `https://api.groq.com/openai/v1/chat/completions`, `https://openrouter.ai/api/v1/chat/completions`, `https://api.deepseek.com/chat/completions`, `https://api.mistral.ai/v1/chat/completions`
4. Use *Probar conexión / Test connection* to verify each agent
5. Go to `#/` and run your first consensus

## Updating

```bash
git pull
npm install
npm run deploy          # UI + API
npx wrangler d1 migrations apply consenso-ai --remote   # only if new migrations exist
```

## Password notes

Admin passwords are stored as `HMAC-HMAC(secret, username:password)` (peppered hash). Changing `JWT_SECRET` invalidates password verification; the fix is deleting the admin row so you can bootstrap again:

```bash
npx wrangler d1 execute consenso-ai --remote --command "DELETE FROM admin_user WHERE id = 1"
```

(Afterwards bootstrap again at `#/admin`.) The same applies if you forget the password.

## Custom domain (optional)

Cloudflare dashboard → Workers & Pages → consenso-ai → Domains & Routes → add your domain. TLS is automatic.

## Operational notes

- **Rate limits** (per IP, adjustable in `packages/shared/src/constants.ts`): 20 consensuses/hour, 40 individual queries/hour, 5 login attempts / 15 min.
- **Logs**: `npx wrangler tail` streams live logs.
- **Free-tier ceilings**: 100k Worker requests/day (static assets are free and don't count), D1 5M row reads/day. A full consensus ≈ a handful of DB rows.
- **Backups**: `npx wrangler d1 export consenso-ai --remote --output=backup.sql`.
- **Health check**: `GET /health` reports agent counts and whether secrets are configured (never their values).

## Security model (honest summary)

- Provider keys: AES-256-GCM with a key derived from `MASTER_KEY`; never returned by any API (only a boolean).
- Admin password: peppered HMAC-SHA256, timing-safe comparison. We deliberately avoid PBKDF2/bcrypt because Workers' 10 ms CPU cap makes high-iteration KDFs unreliable; the pepper + strict login rate limiting provide the practical protection. Use a long generated password.
- Sessions: HttpOnly + Secure + SameSite=Strict cookie, 2 h expiry, **server-side revocation** — logout and password change bump a session version that invalidates all outstanding tokens.
- Everything else: Zod-validated inputs, no CORS surface (same origin), security headers (`nosniff`, `DENY`, no-referrer, HSTS), audit log of every admin action.
