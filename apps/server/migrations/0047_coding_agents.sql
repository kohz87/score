-- Coding agents (PLAN 7.2): Claude Code / Codex CLI / OpenCode as team members. Score keeps only its own record of
-- them; the CLIs keep their own logins. Removed agents stay (past runs and messages refer to them).
CREATE TABLE coding_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL CHECK (runtime IN ('claude-code', 'codex', 'opencode')),
  workspace TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read-only', 'workspace-write', 'full')),
  model TEXT,
  color TEXT NOT NULL,
  shape TEXT NOT NULL,
  -- The CLI version the person confirmed although it is outside the tested series.
  confirmed_version TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT
) STRICT;

-- The CLI's own session id for each (room, agent), so the next turn resumes it.
CREATE TABLE coding_sessions (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id)
) STRICT;

-- 'hermes' for every earlier run. cost_kind: NULL = reported (Hermes), else 'estimated' | 'unknown'.
ALTER TABLE runs ADD COLUMN runtime TEXT NOT NULL DEFAULT 'hermes';
ALTER TABLE runs ADD COLUMN cost_kind TEXT;

-- The CLI process of each running turn, written right after the spawn: after a crash the next start finds the exact
-- process (pid + start time, so a reused pid is never signalled) and stops its whole group before admitting new turns.
CREATE TABLE coding_processes (
  run_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  pgid INTEGER NOT NULL,
  -- /proc/<pid>/stat field 22 (clock ticks since boot); NULL where /proc is not available.
  start_time TEXT,
  created_at TEXT NOT NULL
) STRICT;
