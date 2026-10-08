-- Hermes keeps one cumulative cost per session. Score samples it (at most one row per session per hour) so
-- Reports can split a session's spend across days. Rows older than 60 days are pruned.
CREATE TABLE session_cost_snapshots (
  profile TEXT NOT NULL,
  session_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  estimated INTEGER NOT NULL,
  PRIMARY KEY (profile, session_id, hour)
) WITHOUT ROWID;
CREATE INDEX session_cost_snapshots_observed ON session_cost_snapshots (observed_at);
