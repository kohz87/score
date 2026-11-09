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
-- Which job a session's limits come from, so a change reaches every session of the job, and a started subagent counts.
CREATE TABLE subagent_sessions (
  session_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  job_id TEXT NOT NULL
);
CREATE INDEX subagent_sessions_job ON subagent_sessions (job_id);
