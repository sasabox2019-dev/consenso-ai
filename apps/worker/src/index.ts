/**
 * Consenso AI v2 — Worker entry point.
 * Runs unchanged on Cloudflare Workers and on the local Node dev server.
 */
import { Hono } from "hono";
import type { Env } from "./env";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Security headers on every response
// ---------------------------------------------------------------------------

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("content-security-policy", CSP);
  c.header("referrer-policy", "no-referrer");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (new URL(c.req.url).protocol === "https:") {
    c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
});

// Never cache API responses; reject oversized bodies before any parsing.
app.use("/api/*", async (c, next) => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > 10_000) {
    return c.json(
      { success: false, error: { code: "payload_too_large", message: "Cuerpo demasiado grande." } },
      413,
    );
  }
  await next();
  c.header("cache-control", "no-store");
});

// ---------------------------------------------------------------------------

app.route("/", publicRoutes);
app.route("/", adminRoutes);

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json(
      { success: false, error: { code: "not_found", message: "Endpoint no encontrado." } },
      404,
    );
  }
  // Serve static assets for any non-API path, then fall back to the SPA shell
  // so client-side routes work. (On Cloudflare, static assets are usually
  // served by the platform before the Worker runs; this covers the rest.)
  const asset = await c.env.ASSETS.fetch(new Request(new URL(c.req.url)));
  if (asset.status !== 404) return asset;
  return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
});

app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json(
    { success: false, error: { code: "internal", message: "Error interno del sistema." } },
    500,
  );
});

export default app;
