-- Jobs (PLAN 11.1a, docs/briefs/11.0-bold.md §3): a job is a thread inside a room with its own Hermes sessions.
-- Every room gets one default job here (existing rooms) or by trigger (new rooms); in 11.1a no room has a second job,
-- so room-scoped reads stay exactly job-scoped. A later table rebuild of rooms, messages or message_runs must
-- recreate the triggers below.

-- 'team' = the always-on team room (at most one), 'direct' = an agent's one-to-one home, 'room' = any other room
-- (shown as an older room). 'mentions' = D3.2 @mention routing, 'exchanges' = the 11.1b model.
ALTER TABLE rooms ADD COLUMN role TEXT NOT NULL DEFAULT 'room' CHECK (role IN ('team', 'direct', 'room'));
ALTER TABLE rooms ADD COLUMN routing TEXT NOT NULL DEFAULT 'mentions' CHECK (routing IN ('mentions', 'exchanges'));
UPDATE rooms SET role = 'direct' WHERE kind = 'direct';
CREATE UNIQUE INDEX rooms_team ON rooms (role) WHERE role = 'team';

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'working', 'waiting_on_you', 'done', 'closed')),
  holder_agent_id TEXT,
  -- 'room' = the agent's session is the room's (`score-<room>-<agent>` or the continued outside session), so a
  -- migrated room keeps its history; 'job' = one session per (job, agent), recorded in job_sessions.
  session_scheme TEXT NOT NULL CHECK (session_scheme IN ('room', 'job')),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  recipe_kind TEXT CHECK (recipe_kind IS NULL OR recipe_kind IN ('orchestration', 'workflow')),
  recipe_ref TEXT,
  exchange_budget INTEGER NOT NULL DEFAULT 8 CHECK (exchange_budget BETWEEN 1 AND 100),
  job_turn_limit INTEGER NOT NULL DEFAULT 40 CHECK (job_turn_limit BETWEEN 1 AND 1000),
  spend_cap_usd REAL CHECK (spend_cap_usd IS NULL OR spend_cap_usd > 0),
  source TEXT CHECK (source IS NULL OR json_valid(source)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (is_default = 0 OR session_scheme = 'room')
) STRICT;
CREATE UNIQUE INDEX jobs_default ON jobs (room_id) WHERE is_default = 1;
CREATE INDEX jobs_room_created ON jobs (room_id, created_at, id);

INSERT INTO jobs (id, room_id, title, session_scheme, is_default, created_at, updated_at)
SELECT 'job_' || lower(hex(randomblob(12))), id, name, 'room', 1, created_at, updated_at FROM rooms;

CREATE TRIGGER rooms_default_job AFTER INSERT ON rooms
BEGIN
  UPDATE rooms SET role = 'direct' WHERE id = NEW.id AND NEW.kind = 'direct' AND NEW.role = 'room';
  INSERT INTO jobs (id, room_id, title, session_scheme, is_default, created_at, updated_at)
  VALUES ('job_' || lower(hex(randomblob(12))), NEW.id, NEW.name, 'room', 1, NEW.created_at, NEW.created_at);
END;

-- Sessions of 'job'-scheme jobs. session_id is unique per agent so a session id names exactly one job.
CREATE TABLE job_sessions (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, agent_id)
) STRICT;
CREATE UNIQUE INDEX job_sessions_session ON job_sessions (agent_id, session_id);

ALTER TABLE messages ADD COLUMN job_id TEXT REFERENCES jobs(id);
UPDATE messages SET job_id = (SELECT j.id FROM jobs j WHERE j.room_id = messages.room_id AND j.is_default = 1);
CREATE INDEX messages_job_created_id ON messages (job_id, created_at, id);

-- Writers that don't name a job write into the room's default job.
CREATE TRIGGER messages_default_job AFTER INSERT ON messages WHEN NEW.job_id IS NULL
BEGIN
  UPDATE messages SET job_id = (SELECT j.id FROM jobs j WHERE j.room_id = NEW.room_id AND j.is_default = 1)
  WHERE rowid = NEW.rowid;
END;

ALTER TABLE message_runs ADD COLUMN job_id TEXT REFERENCES jobs(id);
UPDATE message_runs SET job_id = (SELECT j.id FROM jobs j WHERE j.room_id = message_runs.room_id AND j.is_default = 1);
CREATE INDEX message_runs_job ON message_runs (job_id, agent_id);

-- A turn belongs to the job of the message it answers (a hand-off's parent is in the same job).
CREATE TRIGGER message_runs_job AFTER INSERT ON message_runs WHEN NEW.job_id IS NULL
BEGIN
  UPDATE message_runs SET job_id = COALESCE(
    (SELECT m.job_id FROM messages m WHERE m.id = NEW.parent_message_id),
    (SELECT j.id FROM jobs j WHERE j.room_id = NEW.room_id AND j.is_default = 1)
  ) WHERE message_id = NEW.message_id;
END;
