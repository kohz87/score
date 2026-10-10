-- Fix batch H (7.1 v7 review). Orchestrator safety.
-- 1. Where a terminal run status came from: 'runtime' (Hermes said so) or 'recovered' (rebuilt from session-history
--    text after Hermes forgot the run). NULL is a legacy runtime row. Recovered text is shown, never termination evidence.
ALTER TABLE runs ADD COLUMN terminal_source TEXT CHECK (terminal_source IN ('runtime', 'recovered'));

-- 3. The agent mapping a person started the run with: the lead and every allowed agent, by lifecycle incarnation. An
--    assignment or a send for an agent whose current incarnation differs waits for a recorded remap decision.
CREATE TABLE orc_agent_map (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('lead', 'agent')),
  incarnation TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (orchestration_id, agent_id)
) STRICT;
INSERT INTO orc_agent_map (orchestration_id, agent_id, role, incarnation, updated_at)
  SELECT id, lead_agent_id, 'lead', lead_incarnation, created_at FROM orchestrations;
INSERT OR IGNORE INTO orc_agent_map (orchestration_id, agent_id, role, incarnation, updated_at)
  SELECT o.id, j.value, 'agent', COALESCE((SELECT incarnation_id FROM agent_lifecycle WHERE agent_id = j.value), 'untracked'), o.created_at
  FROM orchestrations o, json_each(o.allowed_agents) j;
