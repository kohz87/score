-- 3.20.0 (owner, 2026-11-03): shared workspaces. A workspace is a named folder; agents are assigned to it (many to many)
-- and a room may be set to one. A coding agent's turn in such a room runs in the folder when the agent is assigned.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE workspace_agents (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id)
);
ALTER TABLE rooms ADD COLUMN workspace_id TEXT;
