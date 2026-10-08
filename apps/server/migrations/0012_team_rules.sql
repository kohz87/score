-- Team approval rules (task 2.18). One baseline row; per-agent changes are stricter-only deltas against it.
CREATE TABLE team_rules (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'smart', 'off')),
  go_ahead TEXT NOT NULL CHECK (json_valid(go_ahead)),
  never TEXT NOT NULL CHECK (json_valid(never)),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE agent_rule_overrides (
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('without_go_ahead', 'extra_never')),
  value TEXT NOT NULL,
  PRIMARY KEY (agent_id, kind, value)
) STRICT;
