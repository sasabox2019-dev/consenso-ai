import type { AdminAgent, AuditEntry, PublicAgent } from "@consenso/shared";
/**
 * Admin view: first-run bootstrap → login → panel (agents CRUD, test
 * connection, audit log, password rotation). All state local; API in ../api.
 */
import { useCallback, useEffect, useState } from "react";
import {
  type AgentUpsert,
  ApiError,
  type SessionInfo,
  type TestResult,
  adminAgents,
  bootstrapAdmin,
  changePassword,
  createAgent,
  deleteAgent,
  fetchAudit,
  fetchSession,
  login,
  logout,
  testStoredAgent,
  updateAgent,
} from "../api";
import { useI18n } from "../i18n";

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e);
}

function randomPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// ---------------------------------------------------------------------------

export default function AdminView() {
  const { t } = useI18n();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const refreshSession = useCallback(() => {
    fetchSession()
      .then(setSession)
      .catch((e) => setLoadErr(errMsg(e)));
  }, []);
  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  if (loadErr) return <p className="panel p-4 text-sm text-bad">{loadErr}</p>;
  if (!session) return null;

  if (session.needs_bootstrap) return <Bootstrap onDone={refreshSession} />;
  if (!session.authenticated) return <Login onDone={refreshSession} />;
  return (
    <Panel
      username={session.username ?? "admin"}
      onLogout={refreshSession}
      onSessionExpired={refreshSession}
    />
  );
}

// ---------------------------------------------------------------------------

function Bootstrap({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await bootstrapAdmin(username, password);
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel mx-auto max-w-md space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t("admin_bootstrap_title")}</h1>
        <p className="mt-1 text-sm text-dim">{t("admin_bootstrap_desc")}</p>
      </div>
      <Field label={t("username")}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          minLength={3}
          className={inputCls}
        />
      </Field>
      <Field label={t("password")}>
        <div className="flex gap-2">
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={12}
            autoComplete="new-password"
            className={inputCls}
          />
          <button
            type="button"
            onClick={() => setPassword(randomPassword())}
            className="btn-secondary whitespace-nowrap"
          >
            {t("generate")}
          </button>
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            aria-label={showPassword ? "hide password" : "show password"}
            aria-pressed={showPassword}
            className="btn-secondary"
          >
            {showPassword ? "🙈" : "👁"}
          </button>
        </div>
      </Field>
      {error && <p className="text-sm text-bad">{error}</p>}
      <button type="submit" disabled={busy} className="btn-primary w-full">
        {t("bootstrap")}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------

function Login({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel mx-auto max-w-sm space-y-4 p-6">
      <h1 className="text-lg font-semibold text-ink">{t("login_title")}</h1>
      <Field label={t("username")}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoComplete="username"
          className={inputCls}
        />
      </Field>
      <Field label={t("password")}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          className={inputCls}
        />
      </Field>
      {error && <p className="text-sm text-bad">{error}</p>}
      <button type="submit" disabled={busy} className="btn-primary w-full">
        {t("login")}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------

function Panel({
  username,
  onLogout,
  onSessionExpired,
}: {
  username: string;
  onLogout: () => void;
  onSessionExpired: () => void;
}) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<
    { mode: "create" } | { mode: "edit"; agent: AdminAgent } | null
  >(null);
  const [testing, setTesting] = useState<AdminAgent | null>(null);

  /** Routes 401s back to the login form instead of piling up red banners. */
  const guard = (e: unknown): boolean => {
    if (e instanceof ApiError && e.status === 401) {
      onSessionExpired();
      return true;
    }
    return false;
  };

  const reload = useCallback(() => {
    adminAgents()
      .then(setAgents)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) setError(errMsg(e));
      });
    fetchAudit(100)
      .then(setAuditEntries)
      .catch(() => {});
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const doDelete = async (agent: PublicAgent) => {
    if (!window.confirm(t("confirm_delete"))) return;
    try {
      await deleteAgent(agent.key);
      reload();
    } catch (e) {
      if (!guard(e)) setError(errMsg(e));
    }
  };

  const doLogout = async () => {
    await logout();
    onLogout();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">
          {t("welcome_admin")} <span className="text-cyan">· {username}</span>
        </h1>
        <button type="button" onClick={doLogout} className="btn-secondary">
          {t("logout")}
        </button>
      </div>
      {error && <p className="panel border-bad/40 p-3 text-sm text-bad">{error}</p>}

      <section className="panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{t("agents_crud_title")}</h2>
          <button
            type="button"
            onClick={() => setEditing({ mode: "create" })}
            className="btn-primary py-1.5! text-xs"
          >
            + {t("add_agent")}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="mono-label border-b border-edge text-left">
                <th className="py-2 pr-3">{t("username")}</th>
                <th className="py-2 pr-3">{t("role")}</th>
                <th className="py-2 pr-3">{t("model")}</th>
                <th className="py-2 pr-3">API key</th>
                <th className="py-2 pr-3">{t("active")}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.key} className="border-b border-edge/50">
                  <td className="py-2 pr-3">
                    <span className="text-ink">{a.display_name}</span>
                    <span className="mono-label ml-2">{a.key}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={a.role === "moderator" ? "text-violet" : "text-dim"}>
                      {a.role === "moderator" ? `🧠 ${t("moderator")}` : t("participant")}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-dim">{a.model}</td>
                  <td className="py-2 pr-3">
                    <span className={a.has_api_key ? "text-good" : "text-bad"}>
                      {a.has_api_key ? `● ${t("key_configured")}` : `○ ${t("key_missing")}`}
                    </span>
                  </td>
                  <td className={`py-2 pr-3 ${a.active ? "text-good" : "text-bad"}`}>
                    {a.active ? "✓" : "✗"}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setTesting(a)}
                      className="mr-2 text-xs text-cyan hover:underline"
                    >
                      {t("test_connection")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing({ mode: "edit", agent: a })}
                      className="mr-2 text-xs text-dim hover:text-ink"
                    >
                      {t("edit")}
                    </button>
                    {a.role !== "moderator" && (
                      <button
                        type="button"
                        onClick={() => doDelete(a)}
                        className="text-xs text-bad hover:underline"
                      >
                        {t("delete")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <AgentForm
          initial={editing.mode === "edit" ? editing.agent : null}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          guard={guard}
        />
      )}
      {testing && <TestDialog agent={testing} onClose={() => setTesting(null)} guard={guard} />}

      <PasswordCard guard={guard} />
      <AuditCard entries={auditEntries} />
    </div>
  );
}

// ---------------------------------------------------------------------------

const inputCls =
  "w-full rounded-lg border border-edge bg-void/60 px-3 py-2 text-sm text-ink outline-none transition focus:border-cyan/60";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control arrives via `children` and is nested inside the label at runtime
    <label className="block">
      <span className="mono-label mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function AgentForm({
  initial,
  onCancel,
  onSaved,
  guard,
}: {
  initial: AdminAgent | null;
  onCancel: () => void;
  onSaved: () => void;
  guard: (e: unknown) => boolean;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<AgentUpsert & { key: string }>({
    key: initial?.key ?? "",
    name: initial?.name ?? "",
    display_name: initial?.display_name ?? "",
    url: initial?.url ?? "",
    model: initial?.model ?? "",
    api_key: "",
    timeout_s: initial?.timeout_s ?? 45,
    role: initial?.role ?? "participant",
    active: initial?.active ?? true,
    structured_outputs: initial?.structured_outputs ?? false,
    use_max_completion_tokens: initial?.use_max_completion_tokens ?? false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof AgentUpsert, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: AgentUpsert = {
        name: form.name || undefined,
        display_name: form.display_name || undefined,
        url: form.url || undefined,
        model: form.model || undefined,
        api_key: form.api_key || undefined,
        timeout_s: form.timeout_s,
        role: form.role,
        active: form.active,
        structured_outputs: form.structured_outputs,
        use_max_completion_tokens: form.use_max_completion_tokens,
      };
      if (initial) {
        await updateAgent(initial.key, payload);
      } else {
        await createAgent({ ...payload, key: form.key });
      }
      onSaved();
    } catch (err) {
      if (!guard(err)) setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel space-y-3 p-4">
      <h2 className="text-sm font-semibold text-ink">{initial ? t("edit") : t("add_agent")}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {!initial && (
          <Field label="key">
            <input
              value={form.key}
              onChange={(e) => set("key", e.target.value)}
              required
              pattern="[a-z0-9][a-z0-9_-]{0,31}"
              className={inputCls}
              placeholder="openai"
            />
          </Field>
        )}
        <Field label="display_name">
          <input
            value={form.display_name}
            onChange={(e) => set("display_name", e.target.value)}
            required
            className={inputCls}
            placeholder="ChatGPT"
          />
        </Field>
        <Field label={t("url")}>
          <input
            value={form.url}
            onChange={(e) => set("url", e.target.value)}
            required
            type="url"
            className={inputCls}
            placeholder="https://api.openai.com/v1/chat/completions"
          />
        </Field>
        <Field label={t("model")}>
          <input
            value={form.model}
            onChange={(e) => set("model", e.target.value)}
            required
            className={inputCls}
            placeholder="gpt-4o-mini"
          />
        </Field>
        <Field label={t("role")}>
          <select
            value={form.role}
            onChange={(e) => set("role", e.target.value)}
            className={inputCls}
          >
            <option value="participant">{t("participant")}</option>
            <option value="moderator">{t("moderator")}</option>
          </select>
        </Field>
        <Field label={t("timeout")}>
          <input
            type="number"
            min={5}
            max={120}
            value={form.timeout_s}
            onChange={(e) => set("timeout_s", Number(e.target.value))}
            className={inputCls}
          />
        </Field>
        <label className="flex items-center gap-2 self-end pb-1 text-sm text-dim">
          <input
            type="checkbox"
            checked={form.structured_outputs}
            onChange={(e) => set("structured_outputs", e.target.checked)}
            className="h-4 w-4 accent-cyan"
          />
          {t("structured_outputs")}
        </label>
        <label className="flex items-center gap-2 self-end pb-1 text-sm text-dim">
          <input
            type="checkbox"
            checked={form.use_max_completion_tokens}
            onChange={(e) => set("use_max_completion_tokens", e.target.checked)}
            className="h-4 w-4 accent-cyan"
          />
          {t("max_completion")}
        </label>
        <Field label="name (interno)">
          {/* Required on create: the server needs an internal name for prompts. */}
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            required={!initial}
            className={inputCls}
            placeholder="Agent_ChatGPT"
          />
        </Field>
        <Field label={t("api_key")}>
          <input
            value={form.api_key}
            onChange={(e) => set("api_key", e.target.value)}
            required={!initial}
            minLength={initial ? undefined : 8}
            className={inputCls}
            placeholder={initial ? `(${t("api_key_keep")})` : "sk-…"}
            autoComplete="off"
          />
        </Field>
        {initial && (
          <Field label={t("active")}>
            <select
              value={form.active ? "1" : "0"}
              onChange={(e) => set("active", e.target.value === "1")}
              className={inputCls}
            >
              <option value="1">✓</option>
              <option value="0">✗</option>
            </select>
          </Field>
        )}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn-primary">
          {t("save")}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function TestDialog({
  agent,
  onClose,
  guard,
}: {
  agent: AdminAgent;
  onClose: () => void;
  guard: (e: unknown) => boolean;
}) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      // Empty field → server tests with the stored (decrypted) key.
      setResult(await testStoredAgent(agent.key, apiKey || undefined));
    } catch (e) {
      if (guard(e)) {
        onClose();
      } else {
        setResult({ success: false, message: errMsg(e) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel space-y-3 p-4">
      <h2 className="text-sm font-semibold text-ink">
        {t("test_connection")} · {agent.display_name}
      </h2>
      <Field label={t("api_key")}>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className={inputCls}
          placeholder={agent.has_api_key ? `(${t("api_key_keep")})` : "sk-…"}
          autoComplete="off"
        />
      </Field>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={run}
          disabled={busy || (!apiKey && !agent.has_api_key)}
          className="btn-primary"
        >
          {t("test_connection")}
        </button>
        <button type="button" onClick={onClose} className="btn-secondary">
          {t("cancel")}
        </button>
      </div>
      {result && (
        <p className={`text-sm ${result.success ? "text-good" : "text-bad"}`}>
          {result.success ? `✓ ${t("test_ok")}` : `✕ ${t("test_fail")}: ${result.message}`}
          {result.sample ? ` — ${t("test_sample")}: ${result.sample}` : ""}
          {result.response_time_ms !== undefined
            ? ` (${result.response_time_ms} ${t("time_ms")})`
            : ""}
        </p>
      )}
    </div>
  );
}

function PasswordCard({ guard }: { guard: (e: unknown) => boolean }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await changePassword(current, next);
      setMsg({ ok: true, text: "✓" });
      setCurrent("");
      setNext("");
    } catch (err) {
      if (!guard(err)) setMsg({ ok: false, text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel space-y-3 p-4">
      <h2 className="text-sm font-semibold text-ink">{t("change_password")}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("password_current")}>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            className={inputCls}
            autoComplete="current-password"
          />
        </Field>
        <Field label={t("password_new")}>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={12}
            className={inputCls}
            autoComplete="new-password"
          />
        </Field>
      </div>
      {msg && <p className={`text-sm ${msg.ok ? "text-good" : "text-bad"}`}>{msg.text}</p>}
      <button type="submit" disabled={busy} className="btn-primary">
        {t("save")}
      </button>
    </form>
  );
}

function AuditCard({ entries }: { entries: AuditEntry[] }) {
  const { t } = useI18n();
  return (
    <section className="panel p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">{t("audit_title")}</h2>
      <div className="max-h-72 overflow-y-auto">
        <table className="w-full text-xs">
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-edge/40">
                <td className="py-1.5 pr-3 font-mono text-dim">
                  {e.ts.slice(0, 19).replace("T", " ")}
                </td>
                <td className="py-1.5 pr-3 text-ink">{e.actor}</td>
                <td className="py-1.5 pr-3">
                  <span className={e.action.includes("failed") ? "text-bad" : "text-cyan"}>
                    {e.action}
                  </span>
                  {e.target ? <span className="text-dim"> · {e.target}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
