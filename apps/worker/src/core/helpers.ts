import type { AgentRole, PublicAgent } from "@consenso/shared";
/**
 * Helpers shared by route modules.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../env";
import type { AgentRuntime } from "./consensus";
import { decryptString } from "./crypto";
import type { AgentRow } from "./db";

export function jsonError<E extends { Bindings: Env }>(
  c: Context<E>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  return c.json({ success: false, error: { code, message } }, status);
}

export function toPublicAgent(row: AgentRow): PublicAgent {
  return {
    key: row.key,
    name: row.name,
    display_name: row.display_name,
    role: row.role as AgentRole,
    model: row.model,
    has_api_key: Boolean(row.api_key_ciphertext),
  };
}

/** Decrypts the stored key; returns null when absent or undecryptable. */
export async function toRuntimeAgent(
  row: AgentRow,
  masterKey: string | undefined,
): Promise<AgentRuntime | null> {
  if (!row.api_key_ciphertext || !masterKey) return null;
  try {
    const api_key = await decryptString(masterKey, row.api_key_ciphertext);
    if (!api_key) return null;
    return {
      key: row.key,
      name: row.name,
      display_name: row.display_name,
      url: row.url,
      model: row.model,
      api_key,
      timeout_s: row.timeout_s,
      structured_outputs: Boolean(row.structured_outputs),
      use_max_completion_tokens: Boolean(row.use_max_completion_tokens),
    };
  } catch {
    return null; // Key not decryptable with the current MASTER_KEY.
  }
}
