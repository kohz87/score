-- PLAN 11.1d (docs/briefs/11.1d-sources.md, docs/briefs/11.0-bold.md §7): webhook triggers that start jobs in the team
-- room, and report-back confirmed by the bridge's own record of the tool call.

-- A trigger: an outside app calls POST /hooks/<id> with a Standard Webhooks signature made with `secret` (Score's own
-- secret, sealed with the local key; never an app's credential). `mapping`: JSON paths in the payload for
-- {ref, title?, link?, details?}; `template`: the job's opening text with {{path}} holes; `report_back`:
-- {mode: 'off'|'fixed'|'lead_decides', tool?, args?} where `tool` is a tool of the lead's Hermes profile and `args` a
-- JSON template rendered by Score.
CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  app TEXT NOT NULL,
  secret_sealed TEXT NOT NULL,
  mapping TEXT NOT NULL CHECK (json_valid(mapping)),
  template TEXT NOT NULL,
  report_back TEXT NOT NULL CHECK (json_valid(report_back)),
  -- The last payload, redacted and bounded: the sample the mapping is made from.
  sample TEXT CHECK (sample IS NULL OR json_valid(sample)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_called_at TEXT,
  deleted_at TEXT
) STRICT;

-- Each accepted call once (Standard Webhooks `webhook-id`), kept 24 h for idempotency.
CREATE TABLE trigger_calls (
  trigger_id TEXT NOT NULL REFERENCES triggers(id),
  webhook_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  job_id TEXT REFERENCES jobs(id),
  PRIMARY KEY (trigger_id, webhook_id)
) STRICT;
CREATE INDEX trigger_calls_received ON trigger_calls (received_at);

-- The plugin's digest of a finished tool call's exact arguments (canonical JSON): what confirms a report-back.
ALTER TABLE session_tool_calls ADD COLUMN args_digest TEXT;

-- A job's report-back: the constrained lead turn and its outcome ('pending' | 'confirmed' | 'not_confirmed').
ALTER TABLE jobs ADD COLUMN report_back TEXT CHECK (report_back IS NULL OR json_valid(report_back));
