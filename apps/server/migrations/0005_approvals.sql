CREATE TABLE approvals (
  id TEXT PRIMARY KEY,                       -- random uuid
  origin TEXT NOT NULL CHECK (origin IN ('score-run','gateway','kanban')),
  stage TEXT NOT NULL CHECK (stage IN ('guardian','human')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('run_request','gateway_request','transport','kanban_grant','none')),
  visible INTEGER NOT NULL DEFAULT 1,        -- 0 = hidden stage record (Score-run hook stage without exact requestId)
  profile TEXT NOT NULL,
  session_key TEXT NOT NULL,                 -- Hermes approval session key (= run id for Score-started runs)
  run_id TEXT,
  request_id TEXT,                           -- exact gateway/run target; NULL → never actionable
  transport_request_id TEXT,                 -- a transport's own id (view-only)
  producer_id TEXT,
  producer_incarnation TEXT,
  gate_id TEXT,                              -- producer-minted, unique per gate occurrence
  tool_call_id TEXT, turn_id TEXT, hook_session_id TEXT,   -- informational
  surface TEXT NOT NULL,
  coalesced INTEGER NOT NULL DEFAULT 0,
  linked_to TEXT REFERENCES approvals(id),   -- guardian stage → the human stage it escalated into
  kanban_task_id TEXT,                       -- reserved for 1.13c
  kanban_run_id INTEGER,                     -- reserved for 1.13c
  command TEXT NOT NULL, command_digest TEXT, description TEXT NOT NULL,   -- redacted, ≤ 2 KB each
  pattern_keys TEXT NOT NULL, choices TEXT NOT NULL,                       -- JSON arrays
  -- evidence (principle 4)
  guardian_verdict TEXT CHECK (guardian_verdict IN ('approve','deny','escalate')),
  decision_choice TEXT CHECK (decision_choice IN ('once','session','always','deny')),
  decision_by TEXT CHECK (decision_by IN ('you','guardian','elsewhere','timeout','rule')),
  decided_at TEXT,
  closed_reason TEXT,                        -- timeout | cancelled | notify_failed | transport_failed | run_ended | superseded | expired
  closed_at TEXT,
  tool_outcome TEXT CHECK (tool_outcome IN ('ok','blocked','error')),
  -- derived (recomputed from evidence on every change)
  phase TEXT NOT NULL CHECK (phase IN ('guardian_evaluating','escalated','human_pending','decided','executed','blocked','withdrawn','expired')),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired','withdrawn','unknown')),
  blocking TEXT,
  created_at TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX approvals_request ON approvals(profile, session_key, request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX approvals_gate ON approvals(producer_incarnation, gate_id) WHERE gate_id IS NOT NULL;
CREATE INDEX approvals_transport ON approvals(producer_incarnation, transport_request_id) WHERE transport_request_id IS NOT NULL;
CREATE INDEX approvals_open ON approvals(phase, expires_at);
CREATE INDEX approvals_created ON approvals(visible, created_at, id);
ALTER TABLE approval_signals ADD COLUMN producer_incarnation TEXT;
ALTER TABLE approval_signals ADD COLUMN counter INTEGER;
ALTER TABLE approval_signals ADD COLUMN gate_id TEXT;
ALTER TABLE approval_signals ADD COLUMN linked_gate_id TEXT;
ALTER TABLE approval_signals ADD COLUMN transport_request_id TEXT;
ALTER TABLE approval_signals ADD COLUMN matched_approval_id TEXT;
CREATE INDEX approval_signals_unmatched ON approval_signals(producer_incarnation, gate_id) WHERE matched_approval_id IS NULL;
CREATE INDEX approval_signals_unmatched_request ON approval_signals(profile, session_key, request_id) WHERE matched_approval_id IS NULL;
ALTER TABLE producers ADD COLUMN gateway_approvals INTEGER NOT NULL DEFAULT 0;   -- what hello last enabled
CREATE TABLE approval_deliveries (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),  -- one decision identity per approval
  choice TEXT NOT NULL CHECK (choice IN ('once','session','always','deny')),
  note TEXT,                                 -- redacted, ≤ 500 chars; Score-side only
  route TEXT NOT NULL CHECK (route IN ('port','bridge')),
  producer_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('intent','delivering','applied','not_pending','failed','unknown')),
  maybe_applied INTEGER NOT NULL DEFAULT 0,  -- monotone: once 1, never 0 again
  cycle INTEGER NOT NULL DEFAULT 1,          -- a manual retry after a proven non-application starts a new cycle
  cycle_attempts INTEGER NOT NULL DEFAULT 0, -- attempts in the current cycle (budget: 4)
  lease_id TEXT, lease_until INTEGER,        -- current bridge lease
  next_attempt_at INTEGER,                   -- port backoff, epoch ms
  error TEXT,                                -- short code, never upstream text
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX approval_deliveries_open ON approval_deliveries(state, route, producer_id);
CREATE TABLE approval_delivery_leases (     -- every lease ever issued, so a late receipt can be verified
  lease_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES approval_deliveries(id),
  cycle INTEGER NOT NULL,
  issued_at INTEGER NOT NULL
) STRICT;

CREATE INDEX approvals_links ON approvals(linked_to) WHERE linked_to IS NOT NULL;
CREATE INDEX approval_signals_links ON approval_signals(producer_incarnation, linked_gate_id) WHERE linked_gate_id IS NOT NULL;
CREATE INDEX approval_signals_supersedes ON approval_signals(producer_incarnation, json_extract(payload, '$.supersedesGateId'));
CREATE INDEX approval_signals_unmatched_transport ON approval_signals(producer_incarnation, transport_request_id) WHERE matched_approval_id IS NULL;
