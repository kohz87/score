CREATE TABLE credentials (
  profile TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  key_sha256 TEXT NOT NULL,          -- fingerprint of the key file content; never the key itself
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE runs (
  id TEXT PRIMARY KEY,               -- Hermes run_id
  profile TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('score','kanban','gateway','cron')),
  score_turn_id TEXT UNIQUE,
  credential_generation INTEGER,
  session_id TEXT,
  status TEXT NOT NULL,
  model TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  last_seq INTEGER,                  -- last upstream run-SSE seq applied
  tools_used TEXT NOT NULL DEFAULT '[]',
  output TEXT,                       -- redacted, ≤ 8 KB
  error TEXT,                        -- redacted, ≤ 2 KB
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX runs_profile_status ON runs(profile, status);
CREATE TABLE tool_calls (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,              -- upstream seq of tool.started
  tool TEXT NOT NULL,
  preview TEXT,                      -- redacted command/args preview
  status TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  result_preview TEXT,               -- redacted, ≤ 500 chars
  PRIMARY KEY (run_id, seq)
) STRICT;
