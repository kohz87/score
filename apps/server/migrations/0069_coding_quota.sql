-- 8.1 (decision 82): the latest quota reading of a coding agent's CLI, one row per agent. Only the numbers the CLI
-- printed (used share and reset time per window) and when Score saw them; never any other CLI data.
CREATE TABLE coding_quota (
  agent_id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('usage', 'turn', 'log')),
  windows TEXT NOT NULL
);
