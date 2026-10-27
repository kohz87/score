-- 3.13 (decision 150): the oracle. The check the person set on a job (JSON: argv, workspace, timeout, when) and when they
-- let the job finish without a passing one; each run of it with its verdict and the redacted end of what it printed.
ALTER TABLE orchestrations ADD COLUMN check_json TEXT;
ALTER TABLE orchestrations ADD COLUMN check_waived_at TEXT;
CREATE TABLE orc_checks (
  id TEXT PRIMARY KEY,
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  reason TEXT NOT NULL CHECK (reason IN ('lead', 'step', 'person')),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('queued', 'running', 'passed', 'failed', 'timed_out', 'interrupted', 'refused', 'cancelled')),
  output TEXT NOT NULL DEFAULT ''
);
CREATE INDEX orc_checks_orch ON orc_checks(orchestration_id, queued_at);
