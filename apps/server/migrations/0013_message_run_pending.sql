-- Streamed text that a later chunk could still turn into a secret is held here (sealed with a per-process key)
-- until it settles; see domain/message-runs.ts.
ALTER TABLE message_runs ADD COLUMN pending TEXT NOT NULL DEFAULT '';
