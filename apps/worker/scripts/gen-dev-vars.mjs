import { randomBytes } from "node:crypto";
/**
 * Generates apps/worker/.dev-vars.json with random local secrets (gitignored).
 * These are DEV-ONLY values; production secrets live in `wrangler secret`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", ".dev-vars.json");

if (!existsSync(outFile)) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        master_key: randomBytes(32).toString("hex"),
        jwt_secret: randomBytes(32).toString("hex"),
        bootstrap_token: randomBytes(16).toString("hex"),
      },
      null,
      2,
    ),
  );
  console.log("✅ .dev-vars.json generado (secrets locales aleatorios)");
} else {
  console.log("ℹ️  .dev-vars.json ya existe");
}

// Surface the bootstrap token for convenience (only when this script generated it).
const vars = JSON.parse(readFileSync(outFile, "utf8"));
if (vars.bootstrap_token) {
  console.log(`ℹ️  Bootstrap token dev: ${vars.bootstrap_token}`);
}
