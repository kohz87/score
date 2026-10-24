-- PLAN 11.1b (docs/briefs/11.1b-exchanges.md). Part 1: what was per room becomes per job, before any room gets a
-- second job. Part 2: exchanges and agent actions.

-- Unread per job. room_reads stays (read by nothing now) so a rollback to the previous release still works.
CREATE TABLE job_reads (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  last_read_message_created_at TEXT NOT NULL,
  last_read_message_id TEXT NOT NULL
) STRICT;
INSERT INTO job_reads (job_id, last_read_message_created_at, last_read_message_id)
  SELECT j.id, r.last_read_message_created_at, r.last_read_message_id
  FROM room_reads r JOIN jobs j ON j.room_id = r.room_id AND j.is_default = 1;

-- A share link is one job's snapshot.
ALTER TABLE room_shares ADD COLUMN job_id TEXT REFERENCES jobs(id);
UPDATE room_shares SET job_id = (SELECT j.id FROM jobs j WHERE j.room_id = room_shares.room_id AND j.is_default = 1);

-- A coding CLI's own session per (job, agent). Rows of rooms that no longer exist are dropped (nothing resumes them).
CREATE TABLE coding_sessions_new (
  job_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  instructions_hash TEXT,
  PRIMARY KEY (job_id, agent_id)
) STRICT;
INSERT INTO coding_sessions_new (job_id, agent_id, session_id, updated_at, instructions_hash)
  SELECT j.id, c.agent_id, c.session_id, c.updated_at, c.instructions_hash
  FROM coding_sessions c JOIN jobs j ON j.room_id = c.room_id AND j.is_default = 1;
DROP TABLE coding_sessions;
ALTER TABLE coding_sessions_new RENAME TO coding_sessions;

-- A terminal waiting to be recorded remembers the job whose CLI session it may update.
ALTER TABLE coding_pending_terminals RENAME COLUMN room_id TO job_id;
UPDATE coding_pending_terminals SET job_id = (SELECT j.id FROM jobs j WHERE j.room_id = coding_pending_terminals.job_id AND j.is_default = 1)
  WHERE job_id IS NOT NULL;

-- A room's default job carries the room's name (its title is not shown separately), so it follows a rename.
CREATE TRIGGER rooms_default_job_title AFTER UPDATE OF name ON rooms
BEGIN
  UPDATE jobs SET title = NEW.name, updated_at = NEW.updated_at WHERE room_id = NEW.id AND is_default = 1;
END;

-- Part 2: exchanges (docs/briefs/11.0-bold.md §3.4, §4). Two agents on one step of a job: a hand-off, a question or a
-- review (rounds of send_back). Only rooms with routing = 'exchanges' open them.
CREATE TABLE exchanges (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('handoff', 'ask', 'review')),
  parent_id TEXT REFERENCES exchanges(id),
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'waiting_on_agent', 'waiting_on_you', 'paused_budget', 'done', 'stopped')),
  round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
  turns_used INTEGER NOT NULL DEFAULT 0 CHECK (turns_used >= 0),
  budget INTEGER NOT NULL CHECK (budget >= 1),
  lead_extended INTEGER NOT NULL DEFAULT 0 CHECK (lead_extended IN (0, 1)),
  outcome TEXT CHECK (outcome IN ('approved', 'answered', 'handed_off', 'no_decision')),
  ended_reason TEXT,
  -- The turn whose action opened it.
  opened_by_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX exchanges_job ON exchanges (job_id, state);

-- Which exchange a turn works in (null: a turn the person started), and the hash of its per-turn capability (only
-- while the turn may still act; cleared when it ends).
ALTER TABLE message_runs ADD COLUMN exchange_id TEXT REFERENCES exchanges(id);
ALTER TABLE message_runs ADD COLUMN xtc_hash TEXT;
CREATE UNIQUE INDEX message_runs_xtc ON message_runs (xtc_hash) WHERE xtc_hash IS NOT NULL;

-- Every agent action with its receipt, idempotent per (turn, commandId). 'staged' until the turn ends; then 'applied'
-- (the turn completed) or 'dropped' (it failed or was stopped); 'replaced' by a later call naming it; 'refused' never
-- staged.
CREATE TABLE exchange_actions (
  turn_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('handoff', 'ask', 'review', 'approve', 'send_back', 'reply')),
  args TEXT NOT NULL CHECK (json_valid(args)),
  channel TEXT NOT NULL CHECK (channel IN ('bridge', 'block')),
  state TEXT NOT NULL CHECK (state IN ('staged', 'refused', 'replaced', 'applied', 'dropped')),
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (turn_id, command_id)
) STRICT;
