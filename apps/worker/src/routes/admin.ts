import {
  LIMITS,
  agentCreateSchema,
  agentUpdateSchema,
  bootstrapSchema,
  loginSchema,
  testConnectionSchema,
} from "@consenso/shared";
import type { AgentRole } from "@consenso/shared";
/**
 * Admin API: first-run bootstrap, login/logout/session, agents CRUD,
 * test-connection, audit log. All routes except bootstrap/login/session
 * require a valid session cookie.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import {
  clearSessionCookie,
  extractSessionToken,
  sessionCookie,
  signSession,
  verifySession,
} from "../core/auth";
import {
  decryptString,
  encryptString,
  generatePassword,
  hashPassword,
  verifyPassword,
} from "../core/crypto";
import {
  agentExists,
  audit,
  bumpSessionVersion,
  createAgent,
  deleteAgent,
  getAdmin,
  getAgent,
  getSessionVersion,
  listAgents,
  moderatorCount,
  rateLimit,
  recentAudit,
  setAdmin,
  updateAgentFields,
} from "../core/db";
import { jsonError, toPublicAgent } from "../core/helpers";
import { buildTestUserPrompt } from "../core/prompts";
import { callChatCompletion } from "../core/providers";
import type { Env } from "../env";
import { clientIp } from "../env";

export const adminRoutes = new Hono<{ Bindings: Env; Variables: { adminUser: string } }>();

/** Session guard — every /api/admin/* route requires auth except the public trio. */
adminRoutes.use("/api/admin/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const isPublic =
    path === "/api/admin/bootstrap" || path === "/api/admin/login" || path === "/api/admin/session";
  if (isPublic) return next();

  const secret = c.env.JWT_SECRET;
  if (!secret)
    return jsonError(c, 503, "not_configured", "Sistema sin configurar (falta JWT_SECRET).");
  const token = extractSessionToken(c.req.raw);
  if (!token) return jsonError(c, 401, "unauthorized", "Sesión requerida.");
  const version = await getSessionVersion(c.env.DB);
  const username = await verifySession(secret, token, version);
  if (!username) return jsonError(c, 401, "unauthorized", "Sesión inválida o expirada.");
  c.set("adminUser", username);
  await next();
});

type AdminContext = Context<{ Bindings: Env; Variables: { adminUser: string } }>;
const user = (c: AdminContext) => c.get("adminUser");

// ---------------------------------------------------------------------------
// Bootstrap — first-run only: creates the admin account
// ---------------------------------------------------------------------------

adminRoutes.get("/api/admin/bootstrap", async (c) => {
  const admin = await getAdmin(c.env.DB);
  return c.json({ success: true, needs_bootstrap: admin === null });
});

adminRoutes.post("/api/admin/bootstrap", async (c) => {
  const admin = await getAdmin(c.env.DB);
  if (admin !== null) {
    return jsonError(c, 409, "already_bootstrapped", "El administrador ya existe. Usa login.");
  }
  const ip = clientIp(c.req.raw);
  const verdict = await rateLimit(
    c.env.DB,
    `bootstrap:${ip}`,
    LIMITS.BOOTSTRAP_MAX,
    LIMITS.BOOTSTRAP_WINDOW_S,
  );
  if (!verdict.allowed) {
    return jsonError(c, 429, "rate_limited", "Demasiados intentos de bootstrap.");
  }
  if (!c.env.JWT_SECRET) {
    return jsonError(c, 503, "not_configured", "Falta JWT_SECRET en el entorno.");
  }
  if (c.env.BOOTSTRAP_TOKEN) {
    const bodyToken = await c.req
      .json()
      .then((b) => b?.bootstrap_token)
      .catch(() => undefined);
    if (bodyToken !== c.env.BOOTSTRAP_TOKEN) {
      return jsonError(c, 403, "bad_bootstrap_token", "Token de bootstrap inválido.");
    }
  }
  const parsed = bootstrapSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      c,
      400,
      "invalid_request",
      "Usuario (≥3) y contraseña (≥12 caracteres) requeridos.",
    );
  }
  const { username, password } = parsed.data;
  const hash = await hashPassword(c.env.JWT_SECRET, username, password);
  await setAdmin(c.env.DB, username, hash);
  await audit(c.env.DB, "system", "bootstrap", username, "admin account created");

  const { token, expiresAt } = await signSession(
    c.env.JWT_SECRET,
    username,
    await getSessionVersion(c.env.DB),
  );
  c.header("set-cookie", sessionCookie(token, expiresAt));
  return c.json({ success: true, username });
});

// ---------------------------------------------------------------------------
// Login / logout / session
// ---------------------------------------------------------------------------

adminRoutes.post("/api/admin/login", async (c) => {
  if (!c.env.JWT_SECRET) {
    return jsonError(c, 503, "not_configured", "Sistema sin configurar (falta JWT_SECRET).");
  }
  const ip = clientIp(c.req.raw);
  const ipVerdict = await rateLimit(
    c.env.DB,
    `login:ip:${ip}`,
    LIMITS.LOGIN_MAX_ATTEMPTS * 3,
    LIMITS.LOGIN_WINDOW_S,
  );
  if (!ipVerdict.allowed) {
    return jsonError(c, 429, "rate_limited", "Demasiados intentos desde esta IP.");
  }

  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "invalid_request", "Credenciales requeridas.");
  const { username, password } = parsed.data;

  const userVerdict = await rateLimit(
    c.env.DB,
    `login:user:${username}`,
    LIMITS.LOGIN_MAX_ATTEMPTS,
    LIMITS.LOGIN_WINDOW_S,
  );
  if (!userVerdict.allowed) {
    return jsonError(
      c,
      429,
      "rate_limited",
      "Cuenta bloqueada temporalmente por intentos fallidos.",
    );
  }

  const admin = await getAdmin(c.env.DB);
  const ok =
    admin !== null &&
    (await verifyPassword(c.env.JWT_SECRET, admin.username, password, admin.password_hash)) &&
    admin.username === username;
  if (!ok) {
    await audit(c.env.DB, username || ip, "login_failed", null, null);
    return jsonError(c, 401, "invalid_credentials", "Credenciales incorrectas.");
  }

  const { token, expiresAt } = await signSession(
    c.env.JWT_SECRET,
    admin.username,
    await getSessionVersion(c.env.DB),
  );
  await audit(c.env.DB, admin.username, "login", null, null);
  c.header("set-cookie", sessionCookie(token, expiresAt));
  return c.json({ success: true, username: admin.username });
});

adminRoutes.post("/api/admin/logout", async (c) => {
  // Revoke ALL outstanding sessions by bumping the version; the cleared
  // cookie handles this browser.
  await bumpSessionVersion(c.env.DB);
  await audit(c.env.DB, user(c), "logout", null, null);
  c.header("set-cookie", clearSessionCookie());
  return c.json({ success: true });
});

adminRoutes.get("/api/admin/session", async (c) => {
  const secret = c.env.JWT_SECRET;
  const token = extractSessionToken(c.req.raw);
  if (!secret || !token)
    return c.json({
      success: true,
      authenticated: false,
      needs_bootstrap: (await getAdmin(c.env.DB)) === null,
    });
  const userSession = await verifySession(secret, token);
  return c.json({
    success: true,
    authenticated: userSession !== null,
    username: userSession,
    needs_bootstrap: (await getAdmin(c.env.DB)) === null,
  });
});

// ---------------------------------------------------------------------------
// Agents CRUD (session required)
// ---------------------------------------------------------------------------

adminRoutes.get("/api/admin/agents", async (c) => {
  const rows = await listAgents(c.env.DB);
  return c.json({
    success: true,
    agents: rows.map((r) => ({
      ...toPublicAgent(r),
      url: r.url,
      timeout_s: r.timeout_s,
      active: Boolean(r.active),
    })),
  });
});

adminRoutes.post("/api/admin/agents", async (c) => {
  const parsed = agentCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_request", JSON.stringify(parsed.error.issues[0]?.message));
  }
  const input = parsed.data;

  if (await agentExists(c.env.DB, input.key)) {
    return jsonError(c, 409, "already_exists", `El agente '${input.key}' ya existe.`);
  }
  if (input.role === "moderator" && (await moderatorCount(c.env.DB)) > 0) {
    return jsonError(
      c,
      409,
      "moderator_exists",
      "Ya existe una moderadora activa. Cambia su rol primero.",
    );
  }
  if (!c.env.MASTER_KEY) {
    return jsonError(c, 503, "not_configured", "Falta MASTER_KEY para cifrar la API key.");
  }

  const ciphertext = await encryptString(c.env.MASTER_KEY, input.api_key);
  await createAgent(c.env.DB, {
    key: input.key,
    name: input.name,
    display_name: input.display_name,
    url: input.url,
    model: input.model,
    api_key_ciphertext: ciphertext,
    timeout_s: input.timeout_s,
    role: input.role as AgentRole,
  });
  await audit(
    c.env.DB,
    user(c),
    "agent_create",
    input.key,
    `${input.display_name} (${input.role})`,
  );
  return c.json({ success: true, key: input.key });
});

adminRoutes.put("/api/admin/agents/:key", async (c) => {
  const key = c.req.param("key");
  const row = await getAgent(c.env.DB, key);
  if (!row) return jsonError(c, 404, "not_found", `Agente '${key}' no encontrado.`);

  const parsed = agentUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_request", JSON.stringify(parsed.error.issues[0]?.message));
  }
  const input = parsed.data;

  if (
    input.role === "moderator" &&
    row.role !== "moderator" &&
    (await moderatorCount(c.env.DB)) > 0
  ) {
    return jsonError(
      c,
      409,
      "moderator_exists",
      "Ya existe una moderadora activa. Cambia su rol primero.",
    );
  }

  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.display_name !== undefined) fields.display_name = input.display_name;
  if (input.url !== undefined) fields.url = input.url;
  if (input.model !== undefined) fields.model = input.model;
  if (input.timeout_s !== undefined) fields.timeout_s = input.timeout_s;
  if (input.role !== undefined) fields.role = input.role;
  if (input.active !== undefined) fields.active = input.active ? 1 : 0;
  if (input.api_key !== undefined) {
    if (!c.env.MASTER_KEY) {
      return jsonError(c, 503, "not_configured", "Falta MASTER_KEY para cifrar la API key.");
    }
    fields.api_key_ciphertext = await encryptString(c.env.MASTER_KEY, input.api_key);
  }

  await updateAgentFields(c.env.DB, key, fields);
  await audit(c.env.DB, user(c), "agent_update", key, Object.keys(fields).join(","));
  return c.json({ success: true, key });
});

adminRoutes.delete("/api/admin/agents/:key", async (c) => {
  const key = c.req.param("key");
  const row = await getAgent(c.env.DB, key);
  if (!row) return jsonError(c, 404, "not_found", `Agente '${key}' no encontrado.`);
  if (row.role === "moderator") {
    return jsonError(
      c,
      409,
      "moderator_protected",
      "No se puede eliminar a la moderadora. Cambia su rol primero.",
    );
  }
  await deleteAgent(c.env.DB, key);
  await audit(c.env.DB, user(c), "agent_delete", key, row.display_name);
  return c.json({ success: true, key });
});

// ---------------------------------------------------------------------------
// Test connection + audit log
// ---------------------------------------------------------------------------

adminRoutes.post("/api/admin/test-connection", async (c) => {
  const parsed = testConnectionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return jsonError(c, 400, "invalid_request", "URL, model y api_key requeridos.");
  const { url, model, api_key, timeout_s } = parsed.data;

  const res = await callChatCompletion({
    url,
    model,
    apiKey: api_key,
    messages: [{ role: "user", content: buildTestUserPrompt() }],
    temperature: 0,
    maxTokens: 10,
    timeoutS: timeout_s,
    retries: 0,
    fetcher: c.env.LLM_FETCHER,
  });

  if (res.error || res.content === null) {
    const err = res.error;
    await audit(c.env.DB, user(c), "test_connection", url, err ? `${err.message}` : "empty");
    return c.json({
      success: false,
      message: err?.message ?? "Respuesta vacía",
      detail: err?.detail ?? null,
      response_time_ms: res.elapsed_ms,
    });
  }
  await audit(c.env.DB, user(c), "test_connection", url, "ok");
  return c.json({
    success: true,
    message: "Conexión exitosa",
    sample: res.content.slice(0, 80),
    response_time_ms: res.elapsed_ms,
  });
});

/** Tests an existing agent using its stored config; api_key overrides the stored one. */
adminRoutes.post("/api/admin/agents/:key/test", async (c) => {
  const key = c.req.param("key");
  const row = await getAgent(c.env.DB, key);
  if (!row) return jsonError(c, 404, "not_found", `Agente '${key}' no encontrado.`);
  const body = await c.req.json().catch(() => ({}));
  let apiKey: string | null =
    typeof body?.api_key === "string" && body.api_key.length >= 8 ? body.api_key : null;
  if (!apiKey && row.api_key_ciphertext && c.env.MASTER_KEY) {
    try {
      apiKey = await decryptString(c.env.MASTER_KEY, row.api_key_ciphertext);
    } catch {
      apiKey = null;
    }
  }
  if (!apiKey)
    return jsonError(
      c,
      400,
      "missing_api_key",
      "El agente no tiene API key; escribe una para probar.",
    );

  const res = await callChatCompletion({
    url: row.url,
    model: row.model,
    apiKey,
    messages: [{ role: "user", content: buildTestUserPrompt() }],
    temperature: 0,
    maxTokens: 10,
    timeoutS: 15,
    retries: 0,
    fetcher: c.env.LLM_FETCHER,
  });
  if (res.error || res.content === null) {
    const err = res.error;
    await audit(c.env.DB, user(c), "test_connection", key, err ? err.message : "empty");
    return c.json({
      success: false,
      message: err?.message ?? "Respuesta vacía",
      detail: err?.detail ?? null,
      response_time_ms: res.elapsed_ms,
    });
  }
  await audit(c.env.DB, user(c), "test_connection", key, "ok");
  return c.json({
    success: true,
    message: "Conexión exitosa",
    sample: res.content.slice(0, 80),
    response_time_ms: res.elapsed_ms,
  });
});

adminRoutes.get("/api/admin/audit", async (c) => {
  const limit = Number(c.req.query("limit") ?? "100");
  const rows = await recentAudit(
    c.env.DB,
    Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100,
  );
  return c.json({ success: true, entries: rows });
});

// ---------------------------------------------------------------------------
// Password rotation (session required)
// ---------------------------------------------------------------------------

adminRoutes.post("/api/admin/password", async (c) => {
  if (!c.env.JWT_SECRET) return jsonError(c, 503, "not_configured", "Falta JWT_SECRET.");
  const body = await c.req.json().catch(() => null);
  const current = body?.current_password;
  const next = body?.new_password;
  if (typeof current !== "string" || typeof next !== "string" || next.length < 12) {
    return jsonError(
      c,
      400,
      "invalid_request",
      "Contraseña actual y nueva (≥12 caracteres) requeridas.",
    );
  }
  const admin = await getAdmin(c.env.DB);
  if (
    !admin ||
    !(await verifyPassword(c.env.JWT_SECRET, admin.username, current, admin.password_hash))
  ) {
    return jsonError(c, 401, "invalid_credentials", "Contraseña actual incorrecta.");
  }
  const hash = await hashPassword(c.env.JWT_SECRET, admin.username, next);
  await setAdmin(c.env.DB, admin.username, hash);
  // Revoke all existing sessions (including this one) and re-issue fresh.
  const version = await bumpSessionVersion(c.env.DB);
  const { token, expiresAt } = await signSession(c.env.JWT_SECRET, admin.username, version);
  await audit(c.env.DB, user(c), "password_change", admin.username, null);
  c.header("set-cookie", sessionCookie(token, expiresAt));
  return c.json({ success: true });
});

export { generatePassword };
