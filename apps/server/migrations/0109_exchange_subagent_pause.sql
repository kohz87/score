-- migrate: foreign_keys=off
-- SA.2 (DECISIONS 173): a job at its subagent total pauses and asks. Rebuilt for the wider CHECK; message_runs and the
-- table itself reference it by name, unchanged.
CREATE TABLE exchanges_new (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('handoff', 'ask', 'review')),
  parent_id TEXT REFERENCES exchanges(id),
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'waiting_on_agent', 'waiting_on_you', 'paused_budget', 'done', 'stopped')),
  round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
  turns_used INTEGER NOT NULL DEFAULT 0 CHECK (turns_used >= 0),
  budget INTEGER NOT NULL CHECK (budget >= 1),
  lead_extended INTEGER NOT NULL DEFAULT 0 CHECK (lead_extended IN (0, 1)),
  outcome TEXT CHECK (outcome IN ('approved', 'answered', 'handed_off', 'no_decision')),
  ended_reason TEXT,
  -- The turn whose action opened it.
  opened_by_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  pause_reason TEXT CHECK (pause_reason IN (
    'exchange_budget', 'job_limit', 'spend_cap', 'cost_unknown', 'turn_failed', 'unreachable', 'asker_gone',
    'no_decision', 'author_stalled', 'question_stopped', 'subagent_total')),
  held TEXT CHECK (held IS NULL OR json_valid(held)),
  decider_turn_id TEXT
) STRICT;
INSERT INTO exchanges_new (id, job_id, kind, parent_id, from_agent_id, to_agent_id, state, round, turns_used, budget,
  lead_extended, outcome, ended_reason, opened_by_turn_id, created_at, updated_at, version, pause_reason, held, decider_turn_id)
SELECT id, job_id, kind, parent_id, from_agent_id, to_agent_id, state, round, turns_used, budget,
  lead_extended, outcome, ended_reason, opened_by_turn_id, created_at, updated_at, version, pause_reason, held, decider_turn_id
FROM exchanges;
DROP TABLE exchanges;
ALTER TABLE exchanges_new RENAME TO exchanges;
CREATE INDEX exchanges_job ON exchanges (job_id, state);
