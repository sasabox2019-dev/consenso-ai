/**
 * API client: same-origin relative fetches only, SSE stream parser, typed errors.
 */
import type {
  AdminAgent,
  AuditEntry,
  ConsensusRequest,
  ConsensusResult,
  IndividualRequest,
  IndividualResult,
  PublicAgent,
  StreamEvent,
} from "@consenso/shared";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  return new ApiError(
    body?.error?.code ?? "http_error",
    body?.error?.message ?? `HTTP ${res.status}`,
    res.status,
  );
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export interface AgentsPayload {
  participants: PublicAgent[];
  moderator: PublicAgent | null;
}

export async function fetchAgents(): Promise<AgentsPayload> {
  const res = await fetch("/api/agents");
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<AgentsPayload>;
}

export async function streamConsensus(
  req: ConsensusRequest,
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/consensus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) throw await parseError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // A CRLF pair split across two reads leaves a stray "\r"; hold it back so
    // the delimiter is seen on the next read instead of being missed.
    if (buffer.endsWith("\r")) continue;
    // Normalize CRLF so proxy-rewritten streams still parse.
    buffer = buffer.replace(/\r\n/g, "\n");
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)) as StreamEvent);
          } catch {
            /* skip malformed event */
          }
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
}

export async function askIndividual(
  req: IndividualRequest,
  signal?: AbortSignal,
): Promise<IndividualResult> {
  const res = await fetch("/api/individual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  // Read the body exactly once: parseError consumes it on failures.
  if (!res.ok) throw await parseError(res);
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: IndividualResult;
  } | null;
  if (!body?.success || !body.result) {
    return Promise.reject(
      new ApiError("bad_response", "Respuesta malformada del servidor.", res.status),
    );
  }
  return body.result;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface SessionInfo {
  authenticated: boolean;
  username?: string;
  needs_bootstrap: boolean;
}

export async function fetchSession(): Promise<SessionInfo> {
  const res = await fetch("/api/admin/session");
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<SessionInfo>;
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await parseError(res);
}

export async function logout(): Promise<void> {
  await fetch("/api/admin/logout", { method: "POST" });
}

export async function bootstrapAdmin(username: string, password: string): Promise<void> {
  const res = await fetch("/api/admin/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await parseError(res);
}

export async function adminAgents(): Promise<AdminAgent[]> {
  const res = await fetch("/api/admin/agents");
  if (res.status === 401) throw new ApiError("unauthorized", "unauthorized", 401);
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as { agents: AdminAgent[] };
  return body.agents;
}

export interface AgentUpsert {
  key?: string;
  name?: string;
  display_name?: string;
  url?: string;
  model?: string;
  api_key?: string;
  timeout_s?: number;
  role?: "participant" | "moderator";
  active?: boolean;
}

export async function createAgent(input: AgentUpsert): Promise<void> {
  const res = await fetch("/api/admin/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
}

export async function updateAgent(key: string, input: AgentUpsert): Promise<void> {
  const res = await fetch(`/api/admin/agents/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
}

export async function deleteAgent(key: string): Promise<void> {
  const res = await fetch(`/api/admin/agents/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!res.ok) throw await parseError(res);
}

export interface TestResult {
  success: boolean;
  message: string;
  detail?: string | null;
  sample?: string;
  response_time_ms?: number;
}

export async function testConnection(input: {
  url: string;
  model: string;
  api_key: string;
  timeout_s?: number;
}): Promise<TestResult> {
  const res = await fetch("/api/admin/test-connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<TestResult>;
}

/** Tests an existing agent using its stored URL/model; the given key overrides the stored one. */
export async function testStoredAgent(key: string, api_key?: string): Promise<TestResult> {
  const res = await fetch(`/api/admin/agents/${encodeURIComponent(key)}/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(api_key ? { api_key } : {}),
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<TestResult>;
}

export async function fetchAudit(limit = 100): Promise<AuditEntry[]> {
  const res = await fetch(`/api/admin/audit?limit=${limit}`);
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as { entries: AuditEntry[] };
  return body.entries;
}

export async function changePassword(current: string, next: string): Promise<void> {
  const res = await fetch("/api/admin/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ current_password: current, new_password: next }),
  });
  if (!res.ok) throw await parseError(res);
}

export type { ConsensusResult, IndividualResult, PublicAgent, StreamEvent };
