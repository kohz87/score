-- When a streaming reply's run last showed life (text, tool call, reasoning, approval). Lets Score say "waiting for the
-- model" when a provider is rate-limiting inside Hermes. NULL = since the message was created.
ALTER TABLE messages ADD COLUMN progress_at TEXT;
