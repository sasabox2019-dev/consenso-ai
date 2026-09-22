/**
 * Zod schemas shared by the worker (API) and the web app.
 * Single source of truth for request/response validation.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const AGENT_ROLES = ["participant", "moderator"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const agentKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "lowercase letters, digits, - and _");

/** Agent endpoint URLs must be https (plain http allowed only for loopback/dev mocks). */
export const agentUrlSchema = z
  .string()
  .url()
  .max(500)
  .refine(
    (u) =>
      u.startsWith("https://") ||
      u.startsWith("http://127.0.0.1") ||
      u.startsWith("http://localhost"),
    "must be an https URL (http only for 127.0.0.1/localhost)",
  );

export const agentCreateSchema = z.object({
  key: agentKeySchema,
  name: z.string().min(2).max(64),
  display_name: z.string().trim().min(1).max(64),
  url: agentUrlSchema,
  model: z.string().trim().min(1).max(200),
  api_key: z.string().trim().min(8).max(500),
  timeout_s: z.number().int().min(5).max(120).default(45),
  role: z.enum(AGENT_ROLES).default("participant"),
});
export type AgentCreateInput = z.infer<typeof agentCreateSchema>;

export const agentUpdateSchema = z.object({
  name: z.string().min(2).max(64).optional(),
  display_name: z.string().trim().min(1).max(64).optional(),
  url: agentUrlSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  api_key: z.string().trim().min(8).max(500).optional(),
  timeout_s: z.number().int().min(5).max(120).optional(),
  role: z.enum(AGENT_ROLES).optional(),
  active: z.boolean().optional(),
});
export type AgentUpdateInput = z.infer<typeof agentUpdateSchema>;

/** Agent as exposed publicly (no secrets, only whether a key is configured). */
export interface PublicAgent {
  key: string;
  name: string;
  display_name: string;
  role: AgentRole;
  model: string;
  has_api_key: boolean;
}

/** Agent as seen by the authenticated admin panel (still no secrets). */
export interface AdminAgent extends PublicAgent {
  url: string;
  timeout_s: number;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export const questionSchema = z.string().trim().min(10).max(1000);

export const consensusRequestSchema = z.object({
  question: questionSchema,
  selected_agents: z
    .array(agentKeySchema)
    .length(3)
    .refine((keys) => new Set(keys).size === keys.length, "agents must be unique"),
});
export type ConsensusRequest = z.infer<typeof consensusRequestSchema>;

export const individualRequestSchema = z.object({
  question: questionSchema,
  agent: agentKeySchema,
});
export type IndividualRequest = z.infer<typeof individualRequestSchema>;

// ---------------------------------------------------------------------------
// LLM structured output (participant answers)
// ---------------------------------------------------------------------------

export const agentOutputSchema = z.object({
  /** Informational only — the server NEVER trusts this for identity. */
  agent_id: z.string().optional(),
  confidence: z.coerce
    .number()
    .catch(75)
    .transform((n) => Math.round(Math.min(100, Math.max(0, n)))),
  answer: z.string().min(1),
  key_points: z.array(z.coerce.string()).max(20).catch([]),
  concerns: z.array(z.coerce.string()).max(20).catch([]),
  agree_with: z.array(z.coerce.string()).max(20).catch([]),
});
export type AgentOutput = z.infer<typeof agentOutputSchema>;

// ---------------------------------------------------------------------------
// Consensus result & stream events
// ---------------------------------------------------------------------------

export interface RoundAnswer {
  answer: string;
  key_points: string[];
  concerns: string[];
  agree_with: string[];
  confidence: number;
}

/** Per-round slot: a successful answer, or the error that replaced it. */
export type RoundSlot = { status: "ok"; data: RoundAnswer } | { status: "error"; error: string };

export interface ParticipantResult {
  key: string;
  display_name: string;
  rounds: [RoundSlot, RoundSlot];
  /** True when neither round produced an answer. */
  unavailable: boolean;
  error: string | null;
}

export interface ConsensusMetrics {
  confidence: number;
  agreement_level: "HIGH" | "MODERATE" | "LOW";
  processing_time_s: number;
  agents_ok: number;
  agents_total: number;
}

export interface ConsensusResult {
  question: string;
  consensus: string;
  moderator_key: string;
  moderator_fallback: boolean;
  degraded: boolean;
  participants: ParticipantResult[];
  unavailable_agents: string[];
  metrics: ConsensusMetrics;
  from_cache: boolean;
}

export type StreamEvent =
  | {
      type: "status";
      stage: "start" | "round1" | "round2" | "moderation" | "cache";
      message: string;
    }
  | { type: "round"; round: 1 | 2; status: "start" | "end" }
  | {
      type: "agent";
      round: 1 | 2;
      agent_key: string;
      display_name: string;
      status: "ok" | "error";
      confidence?: number;
      duration_ms?: number;
      error?: string;
    }
  | { type: "moderation"; status: "start" | "end"; duration_ms?: number; fallback?: boolean }
  | { type: "final"; result: ConsensusResult }
  | { type: "error"; code: string; message: string };

export interface IndividualResult {
  question: string;
  agent_key: string;
  display_name: string;
  answer: string;
  key_points: string[];
  concerns: string[];
  confidence: number;
  processing_time_s: number;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

export const bootstrapSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(12).max(200),
  bootstrap_token: z.string().max(200).optional(),
});

export const testConnectionSchema = z.object({
  url: agentUrlSchema,
  model: z.string().trim().min(1).max(200),
  api_key: z.string().trim().min(8).max(500),
  timeout_s: z.number().int().min(5).max(60).default(15),
});

export const passwordChangeSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(12).max(200),
});

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

export interface ApiError {
  success: false;
  error: { code: string; message: string };
}
