/**
 * Local development server: the exact Worker app, served by Node.
 * workerd cannot run on macOS < 13.5, so dev/test/E2E run here; production is
 * unchanged (same code deployed to Cloudflare via `wrangler deploy`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { encryptString } from "./core/crypto";
import app from "./index";
import { createAssetsHandler } from "./node/assets";
import { NodeSqliteD1 } from "./node/d1-sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = join(here, "..");
const repoRoot = join(workerRoot, "..", "..");

// ---------------------------------------------------------------------------
// Secrets (dev)
// ---------------------------------------------------------------------------

const varsFile = join(workerRoot, ".dev-vars.json");
if (!existsSync(varsFile)) {
  console.error(
    "❌ .dev-vars.json no encontrado. Ejecuta: npm run dev (lo genera automáticamente)",
  );
  process.exit(1);
}
const devVars = JSON.parse(readFileSync(varsFile, "utf8")) as {
  master_key: string;
  jwt_secret: string;
};

// ---------------------------------------------------------------------------
// Database: apply migrations, optionally seed demo agents
// ---------------------------------------------------------------------------

const dbFile = process.env.DEV_DB_DIR
  ? join(process.env.DEV_DB_DIR, "consenso-dev.sqlite")
  : join(workerRoot, ".dev", "consenso-dev.sqlite");
mkdirSync(dirname(dbFile), { recursive: true });
const db = new NodeSqliteD1(dbFile);

const migrationsDir = join(workerRoot, "migrations");
const { readdirSync } = await import("node:fs");
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const m of migrations) {
  await db.exec(readFileSync(join(migrationsDir, m), "utf8"));
}

if (process.env.SEED_DEMO === "1") {
  const n = await db.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>();
  if ((n?.n ?? 0) === 0) {
    const demoUrl = process.env.DEMO_LLM_URL ?? "http://127.0.0.1:8790/v1/chat/completions";
    const demoAgents = [
      {
        key: "groq",
        name: "Agent_Groq",
        display_name: "Groq",
        role: "moderator",
        model: "demo-moderator",
      },
      {
        key: "openrouter",
        name: "Agent_OpenRouter",
        display_name: "OpenRouter",
        role: "participant",
        model: "demo-expert-a",
      },
      {
        key: "deepseek",
        name: "Agent_DeepSeek",
        display_name: "DeepSeek",
        role: "participant",
        model: "demo-expert-b",
      },
      {
        key: "mistral",
        name: "Agent_Mistral",
        display_name: "Mistral",
        role: "participant",
        model: "demo-expert-c",
      },
    ];
    for (const a of demoAgents) {
      const ct = await encryptString(devVars.master_key, "demo-key-not-real");
      await db
        .prepare(
          `INSERT INTO agents (key, name, display_name, url, model, api_key_ciphertext, timeout_s, role, active)
           VALUES (?, ?, ?, ?, ?, ?, 20, ?, 1)`,
        )
        .bind(a.key, a.name, a.display_name, demoUrl, a.model, ct, a.role)
        .run();
    }
    console.log(`🌱 4 agentes demo insertados (URL mock: ${demoUrl})`);
  }
}

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

const assets = createAssetsHandler(join(repoRoot, "apps", "web", "dist"));
const port = Number(process.env.PORT ?? 8787);

const env = {
  DB: db,
  ASSETS: {
    fetch: (input: Request | string, init?: RequestInit) => assets(new Request(input, init)),
  },
  MASTER_KEY: devVars.master_key,
  JWT_SECRET: devVars.jwt_secret,
};

serve({ fetch: (req) => app.fetch(req, env as never), port }, (info) => {
  console.log(`🚀 Consenso AI v2 (node dev) → http://localhost:${info.port}`);
  console.log(
    `   UI: http://localhost:${info.port}/   API: http://localhost:${info.port}/api/agents`,
  );
});
