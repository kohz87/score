-- migrate: foreign_keys=off
-- Workflows (PLAN 7.1a; design docs/briefs/7.1-workflow-builder.md v8 .. v8.3). A workflow run is an orchestration whose
-- planner is a fixed graph: `orchestrations` gains `planner` and its lead columns become NULL for such runs.
-- The table is rebuilt (SQLite cannot drop NOT NULL); the migration runner switches foreign keys off for it and checks
-- `foreign_key_check` before the commit.

CREATE TABLE orchestrations_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  planner TEXT NOT NULL DEFAULT 'lead' CHECK (planner IN ('lead', 'workflow')),
  lead_agent_id TEXT,
  lead_incarnation TEXT,
  allowed_agents TEXT NOT NULL CHECK (json_valid(allowed_agents)),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  gate_policy TEXT NOT NULL CHECK (gate_policy IN ('every-step', 'lead-asks', 'none')),
  budget_usd REAL,
  deadline_at TEXT,
  max_steps INTEGER NOT NULL CHECK (max_steps BETWEEN 1 AND 100),
  max_lead_turns INTEGER NOT NULL CHECK (max_lead_turns BETWEEN 0 AND 40),
  max_concurrent_steps INTEGER NOT NULL CHECK (max_concurrent_steps BETWEEN 1 AND 3),
  lead_turn_estimate_usd REAL NOT NULL,
  step_estimate_usd REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'stopping', 'finishing', 'succeeded', 'finished_with_unresolved', 'stopped', 'failed')),
  pause_reason TEXT,
  plan TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(plan)),
  lead_turns_used INTEGER NOT NULL DEFAULT 0,
  steps_created INTEGER NOT NULL DEFAULT 0,
  causes_consumed_up_to INTEGER NOT NULL DEFAULT 0,
  consecutive_lead_failures INTEGER NOT NULL DEFAULT 0,
  finish_requested_at TEXT,
  finish_attempt_id TEXT,
  finish_outcome TEXT CHECK (finish_outcome IN ('success', 'partial', 'failed')),
  finish_summary TEXT,
  stop_requested_at TEXT,
  waiver_at TEXT,
  accepted_unknown_spend INTEGER NOT NULL DEFAULT 0 CHECK (accepted_unknown_spend IN (0, 1)),
  acknowledgement TEXT NOT NULL CHECK (json_valid(acknowledgement)),
  preflight TEXT NOT NULL CHECK (json_valid(preflight)),
  reserve_bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  manual_paused_at TEXT,
  -- v8.1 item 2: the admission revision this run last evaluated (see orc_global.admission_revision).
  admission_seen INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (planner = 'lead' AND lead_agent_id IS NOT NULL AND lead_incarnation IS NOT NULL)
    OR (planner = 'workflow' AND lead_agent_id IS NULL AND lead_incarnation IS NULL)
  )
) STRICT;
INSERT INTO orchestrations_new (
  id, title, goal, planner, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id, gate_policy, budget_usd,
  deadline_at, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status,
  pause_reason, plan, lead_turns_used, steps_created, causes_consumed_up_to, consecutive_lead_failures,
  finish_requested_at, finish_attempt_id, finish_outcome, finish_summary, stop_requested_at, waiver_at,
  accepted_unknown_spend, acknowledgement, preflight, reserve_bytes, stored_bytes, revision, created_at, updated_at,
  ended_at, end_reason, manual_paused_at, admission_seen
) SELECT
  id, title, goal, 'lead', lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id, gate_policy, budget_usd,
  deadline_at, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status,
  pause_reason, plan, lead_turns_used, steps_created, causes_consumed_up_to, consecutive_lead_failures,
  finish_requested_at, finish_attempt_id, finish_outcome, finish_summary, stop_requested_at, waiver_at,
  accepted_unknown_spend, acknowledgement, preflight, reserve_bytes, stored_bytes, revision, created_at, updated_at,
  ended_at, end_reason, manual_paused_at, 0
FROM orchestrations;
DROP TABLE orchestrations;
ALTER TABLE orchestrations_new RENAME TO orchestrations;
CREATE INDEX orchestrations_status ON orchestrations(status);
CREATE UNIQUE INDEX orchestrations_room ON orchestrations(room_id);
CREATE UNIQUE INDEX orchestrations_brief ON orchestrations(brief_id);

-- v8.1 item 2: every change that can make waiting work admissible increments this in its own transaction.
ALTER TABLE orc_global ADD COLUMN admission_revision INTEGER NOT NULL DEFAULT 1;

-- v8.2 / v8.3: dispatch generations of a step attempt. `dispatch_generation` is the latest generation sent;
-- `refused_total` counts proven refusals over the attempt's lifetime, `refused_streak` those since the last accepted send.
ALTER TABLE orc_attempts ADD COLUMN dispatch_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orc_attempts ADD COLUMN refused_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orc_attempts ADD COLUMN refused_streak INTEGER NOT NULL DEFAULT 0;
-- The generation of the latest proven refusal the database committed (restore verification compares it with the journal).
ALTER TABLE orc_attempts ADD COLUMN refused_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orc_attempts ADD COLUMN next_try_at TEXT;
-- Set at the lifetime limit: only the person's decision continues the attempt.
ALTER TABLE orc_attempts ADD COLUMN needs_person INTEGER NOT NULL DEFAULT 0 CHECK (needs_person IN (0, 1));

-- A lead attempt's journaled generation is its capability generation; attempts sent before this migration keep a
-- consistent restore check (their step generations were journaled as 0).
UPDATE orc_attempts
  SET dispatch_generation = (SELECT COUNT(*) FROM orc_capabilities WHERE attempt_id = orc_attempts.id)
  WHERE kind = 'lead';

-- v8.1 item 3: the dispatched bytes are hashed when the assignment is frozen; the send compares.
ALTER TABLE orc_steps ADD COLUMN payload_hash TEXT;

-- ---------------------------------------------------------------------------------------------------------------
-- Definitions: immutable versions; a version is "used" once any run references it.
CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  -- Set when a run starts on this version and never cleared, also after the run is pruned.
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
  PRIMARY KEY (workflow_id, version)
) STRICT;

-- ---------------------------------------------------------------------------------------------------------------
-- The workflow control projection (v8): graph state is its own durable projection. The executor's `after` is not used.
CREATE TABLE wf_runs (
  orchestration_id TEXT PRIMARY KEY REFERENCES orchestrations(id),
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  workflow_name TEXT NOT NULL,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  definition_hash TEXT NOT NULL,
  inputs TEXT NOT NULL CHECK (json_valid(inputs)),
  gate_policy TEXT NOT NULL CHECK (gate_policy IN ('gates-only', 'every-step')),
  unknown_spend TEXT NOT NULL CHECK (unknown_spend IN ('pause', 'continue')),
  planner_generation INTEGER NOT NULL DEFAULT 0,
  -- reached_end | failed | stopped; NULL while the graph is not terminal
  graph_outcome TEXT CHECK (graph_outcome IN ('reached_end', 'failed', 'stopped')),
  graph_reason TEXT,
  rerun_of TEXT,
  compacted_control INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE wf_nodes (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'ready', 'gate_open', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'unresolved')),
  revision INTEGER NOT NULL DEFAULT 1,
  attempts_used INTEGER NOT NULL DEFAULT 0,
  attempts_max INTEGER NOT NULL DEFAULT 0,
  step_id TEXT,
  reason TEXT,
  output TEXT,
  output_truncated INTEGER NOT NULL DEFAULT 0,
  output_revision INTEGER NOT NULL DEFAULT 0,
  verdict TEXT CHECK (verdict IS NULL OR json_valid(verdict)),
  gate_id TEXT,
  remaps INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  PRIMARY KEY (orchestration_id, node_id)
) STRICT;

-- Every executor step a node ever had (oldest first). `reason`: initial | retry | remap.
CREATE TABLE wf_steps (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  step_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('initial', 'retry', 'remap')),
  PRIMARY KEY (orchestration_id, step_id)
) STRICT;
CREATE INDEX wf_steps_node ON wf_steps(orchestration_id, node_id, attempt);

CREATE TABLE wf_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  edge_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ok', 'failed', 'rejected', 'skip', 'branch')),
  produced_by TEXT NOT NULL,
  produced_attempt INTEGER NOT NULL DEFAULT 0,
  consumed_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (orchestration_id, edge_id)
) STRICT;

-- What each consuming attempt read, frozen with the step (v8.2 / fix J: the send verifies it).
CREATE TABLE wf_consumed (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  step_id TEXT NOT NULL,
  consumer TEXT NOT NULL,
  consumer_attempt INTEGER NOT NULL,
  producer TEXT NOT NULL,
  producer_attempt INTEGER NOT NULL,
  producer_step TEXT NOT NULL,
  output_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('output', 'failure', 'default')),
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  PRIMARY KEY (orchestration_id, step_id, producer)
) STRICT;

-- Planner commands: deterministic, run-scoped identities (run is implied by orchestration_id).
CREATE TABLE wf_commands (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  verb TEXT NOT NULL CHECK (verb IN ('assign', 'cancel', 'finish')),
  generation INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'refused')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (orchestration_id, node_id, attempt, verb, generation)
) STRICT;

-- Node gates are local graph nodes: they never queue or reject an executor assignment.
CREATE TABLE wf_gates (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn')),
  revision INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (orchestration_id, id)
) STRICT;

-- The complete-reply facts of a runtime-terminated attempt (v8 "Verdicts and results"): the verdict is parsed from
-- the whole sanitized reply before the stored output is cut.
CREATE TABLE wf_results (
  attempt_id TEXT PRIMARY KEY,
  verdict TEXT CHECK (verdict IS NULL OR json_valid(verdict)),
  output TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  full_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;

-- Saving a definition answers with the whole definition (up to 256 KiB): its idempotency receipt may be that large too,
-- like task details (0010).
CREATE TABLE request_receipts_next (
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  status INTEGER,
  response TEXT CHECK (
    response IS NULL OR (
      json_valid(response) AND length(CAST(response AS BLOB)) <=
        CASE WHEN route = '/api/tasks' OR route LIKE '/api/tasks/%' OR route = '/api/workflows' OR route LIKE '/api/workflows/%'
          THEN 524288 ELSE 65536 END
    )
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, route)
) STRICT;
INSERT INTO request_receipts_next SELECT * FROM request_receipts;
DROP TABLE request_receipts;
ALTER TABLE request_receipts_next RENAME TO request_receipts;
CREATE INDEX request_receipts_created ON request_receipts(created_at);
