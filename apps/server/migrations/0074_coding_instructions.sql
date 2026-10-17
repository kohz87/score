-- PLAN 8.8 (decision 94): a coding agent's "Personality and instructions" (Markdown). Handed to the CLI each session;
-- never written into the workspace. The role column already exists.
ALTER TABLE coding_agents ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
-- The hash of the role/instructions block a CLI session was last sent (NULL = none, i.e. empty). Codex and Antigravity
-- have no instructions flag, so Score re-sends the block in a resumed session only when this differs from the current one.
ALTER TABLE coding_sessions ADD COLUMN instructions_hash TEXT;
