-- 3.17.0 (owner, 2026-11-02): taking over an agent's Bot Desktop through Hermes' lease (docs/briefs/3.17.0-take-over.md).
-- One row per takeover: the audit (who, which agent, when, why it ended) and the hand-back Score still owes Hermes.
-- A row stays 'releasing' until the profile's gateway confirms the hand-back, so a crash or a gateway that is down can't
-- leave the agent paused. viewer_id is a capability (Hermes accepts input and release from it): it never leaves this DB.
CREATE TABLE bot_takeovers (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL UNIQUE,
  epoch INTEGER,
  owner TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('taking', 'active', 'releasing', 'ended')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
CREATE INDEX bot_takeovers_open ON bot_takeovers (state) WHERE state != 'ended';
