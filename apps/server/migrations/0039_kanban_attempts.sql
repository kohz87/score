-- Kanban attempts projection (5.17a-1, design v5 + v5.1). New tables only: `runs`, `message_runs` and the message/FTS
-- triggers are untouched. Timestamps copied from Hermes are epoch seconds (INTEGER); times Score observed are ISO text.

-- One Kanban board database. `path` is the resolved real path.
CREATE TABLE kanban_sources (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  board TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  UNIQUE (path, board)
) STRICT;

-- Score's own epoch for one continuous lineage of a source. Allocation marks come from sqlite_sequence; the three
-- cursors are processing progress. All of them move in the same transaction as the page that advanced them.
CREATE TABLE kanban_histories (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES kanban_sources(id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'closed')),
  reason TEXT,
  event_alloc_mark INTEGER NOT NULL DEFAULT 0,
  attempt_alloc_mark INTEGER NOT NULL DEFAULT 0,
  event_cursor INTEGER NOT NULL DEFAULT 0,
  baseline_cursor INTEGER NOT NULL DEFAULT 0,
  baseline_done INTEGER NOT NULL DEFAULT 0 CHECK (baseline_done IN (0, 1)),
  fullpass_cursor INTEGER NOT NULL DEFAULT 0,
  file_identity TEXT
) STRICT;
CREATE INDEX kanban_histories_source ON kanban_histories(source_id, state);
-- At most one live (active or paused) history per source.
CREATE UNIQUE INDEX kanban_histories_live ON kanban_histories(source_id) WHERE state != 'closed';

CREATE TABLE kanban_attempts (
  id TEXT PRIMARY KEY,                 -- kr_<uuid>, opaque
  source_id TEXT NOT NULL REFERENCES kanban_sources(id),
  history_id TEXT NOT NULL REFERENCES kanban_histories(id),
  attempt_id INTEGER NOT NULL,         -- Hermes task_runs.id
  task_id TEXT NOT NULL,
  profile TEXT,                        -- frozen claim profile: first non-null value seen
  role TEXT CHECK (role IN ('implementer', 'reviewer')),
  status TEXT NOT NULL CHECK (status IN (
    'running', 'completed', 'failed', 'blocked', 'review_handoff', 'changes_requested', 'ended_unknown')),
  closure_reason TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  first_seen_open INTEGER NOT NULL CHECK (first_seen_open IN (0, 1)),
  evidence TEXT NOT NULL CHECK (evidence IN ('proven', 'partial')),
  classification_basis TEXT NOT NULL,
  -- Frozen evidence: captured when first observed, never cleared by a later cleanup.
  claim_lock TEXT,
  claim_event_id INTEGER,
  claim_source_status TEXT,
  worker_pid INTEGER,
  worker_started_at TEXT,
  summary TEXT,
  error TEXT,
  task_snapshot TEXT CHECK (task_snapshot IS NULL OR (json_valid(task_snapshot) AND length(task_snapshot) <= 4096)),
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  copied_from TEXT,
  first_seen TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  -- 1 while an open attempt is under observation; 0 once observation stopped (boundary) or it closed.
  observing INTEGER NOT NULL DEFAULT 1 CHECK (observing IN (0, 1)),
  observation_ended_at TEXT,
  observation_resumed_at TEXT,
  observation_gaps INTEGER NOT NULL DEFAULT 0,
  deleted_upstream_at TEXT,
  refused_updates INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, history_id, attempt_id)
) STRICT;
CREATE INDEX kanban_attempts_task ON kanban_attempts(task_id, started_at);
CREATE INDEX kanban_attempts_time ON kanban_attempts(started_at);
CREATE INDEX kanban_attempts_open ON kanban_attempts(history_id) WHERE ended_at IS NULL;
CREATE INDEX kanban_attempts_identity ON kanban_attempts(source_id, attempt_id);

-- Retry identities of captured reads (kept 7 days by the hourly retention pass).
CREATE TABLE kanban_pages (
  capture_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('baseline', 'tail', 'sweep', 'fullpass')),
  history_id TEXT NOT NULL REFERENCES kanban_histories(id),
  event_from INTEGER,
  event_to INTEGER,
  attempt_from INTEGER,
  attempt_to INTEGER,
  captured_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'stale', 'paused', 'contradiction')),
  malformed INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX kanban_pages_history ON kanban_pages(history_id, kind, captured_at);
CREATE INDEX kanban_pages_captured ON kanban_pages(captured_at);

CREATE TABLE kanban_seen_events (
  history_id TEXT NOT NULL REFERENCES kanban_histories(id),
  event_id INTEGER NOT NULL,
  PRIMARY KEY (history_id, event_id)
) STRICT, WITHOUT ROWID;

-- Late relationship backfill (review edges of tasks linked to a brief after their events were consumed).
-- event_id 0 is the "scan of this task finished" marker.
CREATE TABLE kanban_associations (
  history_id TEXT NOT NULL REFERENCES kanban_histories(id),
  brief_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (history_id, brief_id, task_id, event_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX kanban_associations_event ON kanban_associations(history_id, brief_id, event_id) WHERE event_id > 0;

-- Snapshot of the legacy numeric run links of task projections, resolved later against the current history.
CREATE TABLE kanban_upgrade_links (
  task_id TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  saved_evidence TEXT NOT NULL CHECK (json_valid(saved_evidence)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'mapped', 'unresolved')),
  attempt_key TEXT,
  reason TEXT,
  snapshotted_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (task_id, legacy_id)
) STRICT, WITHOUT ROWID;

-- Marks that the one-time snapshot of task projections into kanban_upgrade_links has run.
CREATE TABLE kanban_upgrade_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshotted_at TEXT NOT NULL
) STRICT;
