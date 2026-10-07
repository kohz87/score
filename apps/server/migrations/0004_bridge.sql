CREATE TABLE producers (
  id TEXT PRIMARY KEY,                 -- random id
  profile TEXT NOT NULL,
  incarnation TEXT NOT NULL UNIQUE,
  pid INTEGER NOT NULL,
  kanban_task_id TEXT,
  isolation TEXT NOT NULL CHECK (isolation IN ('in_process','host','unknown')),
  plugin_version TEXT NOT NULL,
  hermes_version TEXT,
  hermes_code_sha TEXT,
  private_apis TEXT NOT NULL,          -- JSON object name -> bool
  token_hash TEXT NOT NULL,            -- sha256 hex of the current producer token
  token_expires_at INTEGER NOT NULL,   -- epoch ms
  acked_through INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
CREATE INDEX producers_profile ON producers(profile);
CREATE UNIQUE INDEX producers_token_hash ON producers(token_hash);
CREATE TABLE session_tool_calls (
  profile TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_preview TEXT,                   -- redacted, <= 2 KB
  command_digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','ok','error','blocked')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  result_preview TEXT,                 -- redacted, <= 2 KB
  kanban_task_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile, session_id, tool_call_id)
) STRICT;
CREATE TABLE approval_signals (        -- raw approval-hook observations for task 1.14b
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producer_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  hook TEXT NOT NULL,
  session_key TEXT,
  request_id TEXT,
  payload TEXT NOT NULL,               -- redacted JSON
  at TEXT NOT NULL
);
CREATE INDEX approval_signals_at ON approval_signals(at);
