CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX events_ts ON events(ts);
CREATE TABLE ingest_keys (
  source TEXT NOT NULL, identity TEXT NOT NULL, first_seq INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY (source, identity)
) STRICT;
CREATE TABLE ingest_checkpoints (
  source TEXT NOT NULL, scope TEXT NOT NULL, cursor TEXT NOT NULL, incarnation TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (source, scope)
) STRICT;
CREATE TABLE gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, run_id TEXT,
  from_ts TEXT NOT NULL, to_ts TEXT, reason TEXT NOT NULL
) STRICT;
CREATE INDEX gaps_run ON gaps(run_id);
CREATE TABLE command_intents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','sent','accepted','failed','unknown')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, result TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT;
