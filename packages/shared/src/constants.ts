/** System-wide tunables (compile-time constants; change and redeploy to adjust). */
export const LIMITS = {
  /** Login attempts per window before lockout. */
  LOGIN_MAX_ATTEMPTS: 5,
  LOGIN_WINDOW_S: 15 * 60,
  /** Public API budgets per IP (generous for a small group of users). */
  CONSENSUS_MAX: 20,
  CONSENSUS_WINDOW_S: 60 * 60,
  INDIVIDUAL_MAX: 40,
  INDIVIDUAL_WINDOW_S: 60 * 60,
  BOOTSTRAP_MAX: 3,
  BOOTSTRAP_WINDOW_S: 60 * 60,
  /** Session-status polling (unauthenticated endpoint, so still throttled). */
  SESSION_MAX: 120,
  SESSION_WINDOW_S: 15 * 60,
  /** Consensus session cache (per isolate, best-effort cost saver). */
  CACHE_TTL_MS: 10 * 60 * 1000,
  CACHE_MAX_ENTRIES: 30,
  /** LLM calls. */
  LLM_MAX_TOKENS: 3000,
  LLM_RETRIES: 2,
} as const;

export const SESSION_COOKIE = "consenso_session";
export const SESSION_TTL_S = 2 * 60 * 60; // 2 hours
