-- 8.6 (decision 91): the quota guard for coding agents. A floor per coding agent (default 10 percent left, 0 = off), an
-- optional override per run (NULL = each agent's own floor; a workflow run is an orchestrations row too), and the steps
-- held because their agent is below its floor. A held step stays `queued`; this row says why and what it waits for.
ALTER TABLE coding_agents ADD COLUMN quota_floor_percent INTEGER NOT NULL DEFAULT 10
  CHECK (quota_floor_percent BETWEEN 0 AND 50);
ALTER TABLE orchestrations ADD COLUMN quota_floor_percent INTEGER
  CHECK (quota_floor_percent IS NULL OR quota_floor_percent BETWEEN 0 AND 50);
CREATE TABLE orc_quota_holds (
  orchestration_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('5 hours', 'week')),
  group_name TEXT,
  left_percent REAL NOT NULL,
  resets_at TEXT NOT NULL,
  -- held: asks the person; waiting: the person chose to wait for the reset; override: "Use it anyway" for this step.
  state TEXT NOT NULL CHECK (state IN ('held', 'waiting', 'override')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (orchestration_id, step_id)
);
