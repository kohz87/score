CREATE TABLE remote_sessions (
  hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
