-- Tasks that arrive while everyone is paused are held under the team owner (one owner, id 'team'), like the
-- per-brief and per-agent holds: intent first ('pending'), confirmed ('held') once Hermes parked the task.
CREATE TABLE team_paused_tasks (
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  blocked_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'held')),
  legacy INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, task_id)
) STRICT;

-- A plan start is recorded before the first task is created, and each created step is appended, so a crash between
-- steps is finished (same step keys, idempotent) or reported at startup.
CREATE TABLE plan_start_runs (
  message_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  brief_id TEXT NOT NULL,
  steps TEXT NOT NULL CHECK (json_valid(steps)),
  task_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(task_ids)),
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed')),
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
