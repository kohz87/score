-- 3.36.0 (DECISIONS 183): Tasks › Repeating and Tasks › Recipes.
-- Where a repeating job's results go: each new run's saved output written after `since` is posted into the chat once.
CREATE TABLE routine_targets (
  routine_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  since TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE TABLE routine_outputs_posted (
  routine_id TEXT NOT NULL,
  file TEXT NOT NULL,
  message_id TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  PRIMARY KEY (routine_id, file)
);
-- A recipe's schedule, run by Score: what the person saw when setting it (agents, acknowledgement) binds each run.
CREATE TABLE recipe_schedules (
  workflow_id TEXT PRIMARY KEY,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  room_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  agent_map TEXT NOT NULL CHECK (json_valid(agent_map)),
  anchor_at TEXT NOT NULL,
  next_run_at TEXT,
  last_at TEXT,
  last_outcome TEXT CHECK (last_outcome IN ('started', 'missed', 'failed')),
  last_brief_id TEXT,
  last_reason TEXT,
  set_at TEXT NOT NULL
);
-- A deleted chat stops receiving results (the job keeps its output in the agent's runs).
CREATE TRIGGER rooms_delete_drop_routine_targets AFTER DELETE ON rooms
BEGIN
  DELETE FROM routine_targets WHERE room_id = OLD.id;
END;
