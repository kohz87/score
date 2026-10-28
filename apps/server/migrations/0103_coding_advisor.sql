-- 3.14.1 (owner, 2026-10-28): a Claude Code agent's own advisor model (Claude Code's --advisor), set on the agent like its
-- effort and used on every turn; null = none.
ALTER TABLE coding_agents ADD COLUMN advisor_model TEXT;
