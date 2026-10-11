-- Antigravity (`agy`, PLAN 7.6) joins the coding runtimes. SQLite cannot change a CHECK in place: rebuild the table
-- (nothing references coding_agents by foreign key).
CREATE TABLE coding_agents_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL CHECK (runtime IN ('claude-code', 'codex', 'antigravity', 'opencode')),
  workspace TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read-only', 'workspace-write', 'full')),
  model TEXT,
  color TEXT NOT NULL,
  shape TEXT NOT NULL,
  confirmed_version TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT
) STRICT;
INSERT INTO coding_agents_new (id, name, role, runtime, workspace, permission, model, color, shape, confirmed_version, created_at, removed_at)
  SELECT id, name, role, runtime, workspace, permission, model, color, shape, confirmed_version, created_at, removed_at FROM coding_agents;
DROP TABLE coding_agents;
ALTER TABLE coding_agents_new RENAME TO coding_agents;
