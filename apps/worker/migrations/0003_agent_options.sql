-- Per-agent modern-API capability flags (2026 provider landscape):
-- structured_outputs: send response_format {type:"json_object"} where the
--   provider supports JSON mode (OpenAI, DeepSeek, OpenRouter, Groq...).
-- use_max_completion_tokens: OpenAI reasoning models (o-series) reject
--   max_tokens and require max_completion_tokens instead; Mistral et al.
--   reject the new name, so this stays a per-agent opt-in.
ALTER TABLE agents ADD COLUMN structured_outputs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN use_max_completion_tokens INTEGER NOT NULL DEFAULT 0;
