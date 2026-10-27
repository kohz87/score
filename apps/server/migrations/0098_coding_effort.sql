-- 3.9.0 (decision 147): reasoning effort per coding agent (Claude Code, Codex). NULL = Default: the CLI sends nothing.
ALTER TABLE coding_agents ADD COLUMN effort TEXT;
