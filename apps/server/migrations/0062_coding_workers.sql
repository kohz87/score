-- 7.7b part 1 (design v6 §§5-7): coding agents as orchestration workers.
--
-- Per-generation identities: a coding attempt's dispatch generation g has its own turn id, launch id and run, so a
-- refusal or a revoked launch followed by a redispatch can never attach the older generation's run again.
ALTER TABLE orc_attempts ADD COLUMN runtime TEXT NOT NULL DEFAULT 'hermes';
-- K2: a step blocked "agent_changed" keeps exactly one attempt; dispatch skips it and it holds no concurrency slot.
ALTER TABLE orc_attempts ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1));
-- The complete eligible reply of a coding worker (limit 32 KiB, cut at a character boundary), written in the same
-- transaction as the terminal state; the lead is fed from it, never from the 8 KiB run output.
ALTER TABLE orc_attempts ADD COLUMN result_text TEXT;
ALTER TABLE orc_attempts ADD COLUMN result_truncated INTEGER NOT NULL DEFAULT 0 CHECK (result_truncated IN (0, 1));

CREATE TABLE orc_generations (
  attempt_id TEXT NOT NULL REFERENCES orc_attempts(id),
  generation INTEGER NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  launch_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  -- The run this generation's startRun returned (the handle); older generations keep theirs as evidence.
  run_id TEXT,
  -- Set when the generation was proven to have launched nothing (`send_closed`), with its typed cause.
  closed_cause TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, generation)
) STRICT;

-- Reply rows and start intents attach by (attempt, generation), never by the attempt's logical turn id.
ALTER TABLE message_runs ADD COLUMN generation INTEGER;
ALTER TABLE command_intents ADD COLUMN orchestration_attempt_id TEXT;
ALTER TABLE command_intents ADD COLUMN generation INTEGER;

-- The launch's permanent owner (M4) and the typed cause of its revocation, projected from the coding journal.
ALTER TABLE coding_launches ADD COLUMN owner_orchestration TEXT;
ALTER TABLE coding_launches ADD COLUMN owner_attempt TEXT;
ALTER TABLE coding_launches ADD COLUMN owner_generation INTEGER;
ALTER TABLE coding_launches ADD COLUMN revoke_cause TEXT;
CREATE INDEX coding_launches_owner ON coding_launches (owner_orchestration);

-- A coding run that ended before any launch was requested (a readiness refusal, a fence, a missing CLI), with the
-- reason class the executor maps to its cause table.
CREATE TABLE coding_refusals (
  run_id TEXT PRIMARY KEY,
  cause TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
) STRICT;

-- The complete eligible reply of a coding run (7.7a's authoritative reply, at most 32 KiB, cut at a character
-- boundary), written in the same transaction as the run's terminal state. The executor copies it into the attempt's
-- `result_text` when it accepts the result; nothing else ever feeds a worker's result to the lead.
CREATE TABLE coding_run_results (
  run_id TEXT PRIMARY KEY,
  reply TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;
