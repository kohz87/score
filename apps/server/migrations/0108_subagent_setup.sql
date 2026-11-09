-- SA.1, SA.2 (DECISIONS 173): subagents, an agent's own throwaway helpers.
-- An agent's ceiling. inline_since: when a Hermes profile went inline. A Hermes session keeps the delegation mode it
-- started with, so a session Score already ran before this moment is still in background mode, and subagents stay off in it.
CREATE TABLE subagent_agents (
  profile TEXT PRIMARY KEY,
  inline_since TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_concurrent INTEGER NOT NULL DEFAULT 4
);
-- A job's limits, which can only narrow the agent's; max_concurrent NULL means the agent's own. used: started so far.
ALTER TABLE jobs ADD COLUMN subagents_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN subagents_max_concurrent INTEGER;
ALTER TABLE jobs ADD COLUMN subagents_max_total INTEGER NOT NULL DEFAULT 20;
ALTER TABLE jobs ADD COLUMN subagents_used INTEGER NOT NULL DEFAULT 0;
-- subagents_chain: the person's request a room's own thread last started its count for.
ALTER TABLE jobs ADD COLUMN subagents_chain TEXT;
-- Which job a session's limits come from, so a change reaches every session of the job, and a started subagent counts.
-- inline: Hermes froze the session's mode when it began, so once seen as background it stays so.
CREATE TABLE subagent_sessions (
  session_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  job_id TEXT NOT NULL,
  inline INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX subagent_sessions_job ON subagent_sessions (job_id);
-- One row per subagent, for the chat's status card and the job map. id: the child's Hermes session, or Claude Code's call.
CREATE TABLE subagents (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  goal TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  cost_usd REAL,
  tokens INTEGER
);
CREATE INDEX subagents_job ON subagents (job_id, started_at);
