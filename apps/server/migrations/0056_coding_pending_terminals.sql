-- Fix batch DD (audit 3, S3-004). The CLI has ended but its terminal result could not be saved yet: the outcome is
-- kept here, written before the first attempt, retried until committed, and committed on restart before anything is
-- marked interrupted. The process record stays until the same commit releases it.
CREATE TABLE coding_pending_terminals (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  room_id TEXT,
  usage TEXT,
  info TEXT NOT NULL,
  created_at TEXT NOT NULL
);
