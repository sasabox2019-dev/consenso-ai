/**
 * Best-effort in-isolate TTL cache for consensus results (cost saver).
 * Per-isolate by design: Workers isolates are ephemeral, so this is a
 * probabilistic cache — identical questions from different isolates may miss.
 * No persistent store means no copy of user questions leaves the request path.
 */
import { LIMITS } from "@consenso/shared";
import type { ConsensusResult } from "@consenso/shared";

interface Entry {
  expires: number;
  value: ConsensusResult;
}

const store = new Map<string, Entry>();

export async function cacheKey(question: string, agentKeys: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${question}|${[...agentKeys].sort().join(",")}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function cacheGet(key: string): ConsensusResult | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function cachePut(key: string, value: ConsensusResult): void {
  if (store.size >= LIMITS.CACHE_MAX_ENTRIES) {
    // Drop the oldest entry (Map preserves insertion order).
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { expires: Date.now() + LIMITS.CACHE_TTL_MS, value });
}
