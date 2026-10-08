-- A brief is a human room message plus what it causes. Its id is the root message id (= message_runs.chain_id).
-- Links to tasks are exact only: rows are written when Score creates a task for the brief or sees a Kanban child.
CREATE TABLE briefs (
  id TEXT PRIMARY KEY REFERENCES messages(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  started_by TEXT NOT NULL,
  paused_at TEXT,
  -- Status is derived on read. This only remembers the last status carried by a brief.upserted event, so the
  -- ingest hook can emit another one when it changes.
  emitted_status TEXT
) STRICT;
CREATE INDEX briefs_started ON briefs(started_at);

CREATE TABLE brief_tasks (
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  task_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('assign', 'plan', 'child')),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (brief_id, task_id)
) STRICT;
CREATE INDEX brief_tasks_task ON brief_tasks(task_id);

-- Tasks that pause blocked itself; resume unblocks only these.
CREATE TABLE brief_paused_tasks (
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  task_id TEXT NOT NULL,
  blocked_at TEXT NOT NULL,
  PRIMARY KEY (brief_id, task_id)
) STRICT;

-- Plan messages whose steps were started (idempotent per plan message).
CREATE TABLE brief_plan_starts (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  started_at TEXT NOT NULL
) STRICT;

-- Review, sent-back and hand-off edges announced by handoff.created events that carry a brief id.
CREATE TABLE brief_edges (
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('handoff', 'review', 'sent_back')),
  from_block TEXT NOT NULL,
  to_block TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (brief_id, id)
) STRICT;

-- Lane blocks announced for a brief, so edge endpoints (block ids) resolve to flow nodes.
CREATE TABLE brief_blocks (
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  block_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  PRIMARY KEY (brief_id, block_id)
) STRICT;

-- The turn that was asked for a plan first; its hand-offs wait for Start plan.
ALTER TABLE message_runs ADD COLUMN plan_first INTEGER NOT NULL DEFAULT 0 CHECK (plan_first IN (0, 1));
