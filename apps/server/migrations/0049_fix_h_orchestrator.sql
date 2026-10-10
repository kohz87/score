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

-- 4. Legacy provenance: NULL no longer means "runtime" for runs recovered before this upgrade. A terminal run with the
--    gap the recovery wrote is 'recovered'; every other terminal run is 'runtime'.
UPDATE runs SET terminal_source = CASE
    WHEN EXISTS (
      SELECT 1 FROM gaps g
      WHERE g.run_id = runs.id AND g.reason = 'Run record expired; the result was recovered from the session history'
    ) THEN 'recovered' ELSE 'runtime' END
  WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted');
-- An attempt that ended on recovered text was never confirmed ended: it becomes unknown (fencing its run); a result
-- already accepted from it stays visible.
UPDATE orc_attempts SET state = 'unknown', unknown_reason = 'recovered_text_only', evidence = NULL, terminated_at = NULL,
    settled = 0
  WHERE state = 'terminated' AND run_id IN (SELECT id FROM runs WHERE terminal_source = 'recovered');

-- 5. A manual Pause is held independently of budget / unknown-spend / deadline / agent conditions.
ALTER TABLE orchestrations ADD COLUMN manual_paused_at TEXT;
UPDATE orchestrations SET manual_paused_at = updated_at WHERE status = 'paused' AND pause_reason = 'person';
