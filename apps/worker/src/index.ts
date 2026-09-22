/**
 * Consenso AI v2 — Worker entry point.
 * Runs unchanged on Cloudflare Workers and on the local Node dev server.
 */
import { Hono } from "hono";
import type { Env } from "./env";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

// ---------------------------------------------------------------------------
// Security headers on every response + request correlation
// ---------------------------------------------------------------------------

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

app.use("*", async (c, next) => {
  // Correlates an HTTP response (and log lines) to a single request.
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
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

// API hygiene: never cache responses; reject the two body-size bypass paths —
// chunked transfer-encoding (no length at all) and oversized declared bodies.
app.use("/api/*", async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") {
    const contentLength = c.req.header("content-length");
    if (c.req.header("transfer-encoding") !== undefined) {
      return c.json(
        {
          success: false,
          error: { code: "length_required", message: "Transfer-encoding no soportado." },
        },
        411,
      );
    }
    if (contentLength !== undefined && Number(contentLength) > 10_000) {
      return c.json(
        {
          success: false,
          error: { code: "payload_too_large", message: "Cuerpo demasiado grande." },
        },
        413,
      );
    }
  }
  await next();
  // Don't clobber SSE's `no-cache, no-transform` with plain `no-store`.
  if (!c.res.headers.has("cache-control")) {
    c.header("cache-control", "no-store");
  }
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
  console.error(`[${c.get("requestId")}] unhandled error`, err);
  return c.json(
    {
      success: false,
      error: { code: "internal", message: "Error interno del sistema." },
    },
    500,
  );
});

export default app;
