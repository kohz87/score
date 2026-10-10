-- Orchestrator (PLAN 7.5a; design docs/briefs/7.5-orchestrator.md v3 + v3.1). A Score-owned run in which a lead agent
-- decides steps at runtime. Everything the executor must survive a crash with lives here; the external execution
-- journal (outside $SCORE_HOME) mirrors admissions and fences so a restored database is detected.
-- Times are ISO-8601 text. Money is USD as REAL; NULL means "not known" and is never treated as zero.

CREATE TABLE orchestrations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  lead_agent_id TEXT NOT NULL,
  lead_incarnation TEXT NOT NULL,
  allowed_agents TEXT NOT NULL CHECK (json_valid(allowed_agents)),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  gate_policy TEXT NOT NULL CHECK (gate_policy IN ('every-step', 'lead-asks', 'none')),
  budget_usd REAL,
  deadline_at TEXT,
  max_steps INTEGER NOT NULL CHECK (max_steps BETWEEN 1 AND 30),
  max_lead_turns INTEGER NOT NULL CHECK (max_lead_turns BETWEEN 1 AND 40),
  max_concurrent_steps INTEGER NOT NULL CHECK (max_concurrent_steps BETWEEN 1 AND 3),
  lead_turn_estimate_usd REAL NOT NULL,
  step_estimate_usd REAL NOT NULL,
  -- running | paused | stopping | finishing | succeeded | finished_with_unresolved | stopped | failed
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'stopping', 'finishing', 'succeeded', 'finished_with_unresolved', 'stopped', 'failed')),
  -- Why a paused run is paused: 'person' or a system reason that needs the person (budget, deadline, ...).
  pause_reason TEXT,
  plan TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(plan)),
  lead_turns_used INTEGER NOT NULL DEFAULT 0,
  steps_created INTEGER NOT NULL DEFAULT 0,
  -- Wake cursor: the lead attempt that is claimed consumed every cause up to this id.
  causes_consumed_up_to INTEGER NOT NULL DEFAULT 0,
  consecutive_lead_failures INTEGER NOT NULL DEFAULT 0,
  -- Finish request (a durable seal on further commands) and its outcome.
  finish_requested_at TEXT,
  finish_attempt_id TEXT,
  finish_outcome TEXT CHECK (finish_outcome IN ('success', 'partial', 'failed')),
  finish_summary TEXT,
  -- Stop fence (journaled) and the recorded waiver "continue while a cancelled step may still run".
  stop_requested_at TEXT,
  waiver_at TEXT,
  acknowledgement TEXT NOT NULL CHECK (json_valid(acknowledgement)),
  preflight TEXT NOT NULL CHECK (json_valid(preflight)),
  -- Storage: the reserve taken at creation and the bytes of text stored so far.
  reserve_bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
) STRICT;
CREATE INDEX orchestrations_status ON orchestrations(status);
CREATE UNIQUE INDEX orchestrations_room ON orchestrations(room_id);
CREATE UNIQUE INDEX orchestrations_brief ON orchestrations(brief_id);

CREATE TABLE orc_steps (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  agent_incarnation TEXT NOT NULL,
  instruction TEXT NOT NULL,
  after_steps TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(after_steps)),
  replaces TEXT,
  -- pending_gate | queued | admitted | succeeded | failed | unknown | cancelled | blocked | rejected | not_started
  status TEXT NOT NULL CHECK (status IN ('pending_gate', 'queued', 'admitted', 'succeeded', 'failed', 'unknown', 'cancelled', 'blocked', 'rejected', 'not_started')),
  disposition TEXT,
  estimate_usd REAL NOT NULL,
  result TEXT,
  result_revision INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  created_in_attempt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (orchestration_id, id)
) STRICT;

CREATE TABLE orc_attempts (
  id TEXT PRIMARY KEY,
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  kind TEXT NOT NULL CHECK (kind IN ('lead', 'step')),
  step_id TEXT,
  n INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  agent_incarnation TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  -- created | send_started | running | terminated | unknown | refused | abandoned
  state TEXT NOT NULL CHECK (state IN ('created', 'send_started', 'running', 'terminated', 'unknown', 'refused', 'abandoned')),
  -- Capability-free by construction: the lead's rendered input holds a placeholder, never the capability.
  input TEXT NOT NULL,
  run_id TEXT,
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  stop_requested_at TEXT,
  stop_acknowledged_at TEXT,
  terminated_at TEXT,
  -- Termination evidence (7.1 v6): only 'completed' or 'failed' from the run's own agent loop.
  evidence TEXT CHECK (evidence IN ('completed', 'failed')),
  unknown_reason TEXT,
  reserved_usd REAL NOT NULL DEFAULT 0,
  spend_usd REAL,
  spend_complete INTEGER NOT NULL DEFAULT 0 CHECK (spend_complete IN (0, 1)),
  settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1)),
  -- Lead attempts: the causes this attempt consumed (claim_to is what the cursor moved to).
  claim_from INTEGER,
  claim_to INTEGER,
  commands INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  abandoned_at TEXT
) STRICT;
CREATE UNIQUE INDEX orc_attempts_run ON orc_attempts(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX orc_attempts_orch ON orc_attempts(orchestration_id, state);

-- Capabilities are bearer authority: only the hash is stored, one per dispatch (a re-dispatch mints a new generation).
CREATE TABLE orc_capabilities (
  hash TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES orc_attempts(id),
  generation INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  agent_incarnation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expired_at TEXT
) STRICT;
CREATE INDEX orc_capabilities_attempt ON orc_capabilities(attempt_id);

-- Every orch.* call is a command with a lead-chosen id, unique within its lead attempt.
CREATE TABLE orc_commands (
  attempt_id TEXT NOT NULL REFERENCES orc_attempts(id),
  command_id TEXT NOT NULL,
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  tool TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, command_id)
) STRICT;

-- Why the lead should run again. The cursor on the orchestration says which causes a claimed attempt consumed.
CREATE TABLE orc_causes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  kind TEXT NOT NULL,
  ref TEXT,
  detail TEXT,
  at TEXT NOT NULL
) STRICT;
CREATE INDEX orc_causes_orch ON orc_causes(orchestration_id, id);

-- Human decisions bound to an exact assignment (payload frozen at creation).
CREATE TABLE orc_gates (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('policy', 'lead')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn')),
  revision INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (orchestration_id, id)
) STRICT;

-- Questions to the person: the answer is data for the next lead turn and never changes permissions.
CREATE TABLE orc_inquiries (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'withdrawn')),
  answer TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  PRIMARY KEY (orchestration_id, id)
) STRICT;

-- Recorded human decisions and ownership transitions, append-only.
CREATE TABLE orc_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orchestration_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL CHECK (json_valid(detail)),
  at TEXT NOT NULL
) STRICT;
CREATE INDEX orc_history_orch ON orc_history(orchestration_id, id);

-- Single row: the global admission fence (restore / journal problems) and the untrusted-history marker.
CREATE TABLE orc_global (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fenced INTEGER NOT NULL DEFAULT 0 CHECK (fenced IN (0, 1)),
  reason TEXT,
  fence_seq INTEGER NOT NULL DEFAULT 0,
  untrusted_history INTEGER NOT NULL DEFAULT 0 CHECK (untrusted_history IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  since TEXT,
  lifted_at TEXT
) STRICT;
INSERT INTO orc_global (id) VALUES (1);

-- What the reconciliation screen lists: journal entries the database lacks, and other doubts.
CREATE TABLE orc_fence_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fence_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  journal_n INTEGER,
  detail TEXT NOT NULL
) STRICT;

-- Orchestration dispatches are recovered only by the orchestration executor, never by generic intent recovery.
ALTER TABLE command_intents ADD COLUMN owner TEXT CHECK (owner IN ('orchestration'));

-- Reply rows of orchestration attempts: no mention routing, no plan materialisation (see message-runs.ts).
ALTER TABLE message_runs ADD COLUMN orchestration_attempt_id TEXT;
