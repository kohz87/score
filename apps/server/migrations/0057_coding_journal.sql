-- 7.7a part 1 (design v7 §2/§3): the database side of the coding-run journal. `coding_launches` is the projection the
-- journal's critical section commits (the journal stays authoritative; recovery rebuilds missing rows from it) and
-- `coding_journal_checkpoint` holds the newest coding record number the database has seen: a checkpoint behind the
-- journal (an older backup) fences coding admission until reconciled.
CREATE TABLE coding_launches (
  launch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  may_have_executed INTEGER NOT NULL DEFAULT 0,
  unit TEXT,
  invocation_id TEXT,
  cgroup TEXT,
  proof TEXT,
  disposition TEXT,
  waiver INTEGER NOT NULL DEFAULT 0,
  -- The journal number of the record this row reflects; a row only ever moves forward.
  journal_n INTEGER NOT NULL,
  -- Permanently set once the journal witnessed an execution (or a revocation): this launch is never sent again.
  unsendable INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX coding_launches_run ON coding_launches (run_id);

CREATE TABLE coding_journal_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
INSERT INTO coding_journal_checkpoint (id, seq) VALUES (1, 0);
