-- Enforce the single-active-moderator invariant at the database level (the
-- application-level 409 checks remain for friendly errors). Partial unique
-- index: at most one active moderator row can exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_single_moderator
  ON agents(role) WHERE role = 'moderator' AND active = 1;

-- Speeds up the opportunistic housekeeping DELETE on rate_limits.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
