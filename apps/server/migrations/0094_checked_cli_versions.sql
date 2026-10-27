-- 3.7.7 (decision 138): CLI versions Score checked itself from their help text, so a coding agent can take orchestration
-- steps after its CLI updates. Forward-only; a row is never removed (the check is per version, the file identity is
-- checked at each launch).
CREATE TABLE checked_cli_versions (
  runtime TEXT NOT NULL,
  version TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (runtime, version)
) STRICT;
