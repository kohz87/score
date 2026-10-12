-- 7.7a part 3 (design v7 §§1-6b): what the unit backend keeps next to the journal's own state. The journal stays
-- authoritative for phase, revocation and release possibility; these columns route a launch (agent, runtime, backend),
-- name its evidence (receipt directory, spec directory, manager incarnation) and hold the stop cause and the verdict
-- on its result. `backend` is stored per launch and never switched for an uncertain one.
ALTER TABLE coding_launches ADD COLUMN backend TEXT;
ALTER TABLE coding_launches ADD COLUMN agent_id TEXT;
ALTER TABLE coding_launches ADD COLUMN runtime TEXT;
ALTER TABLE coding_launches ADD COLUMN receipt_dir TEXT;
ALTER TABLE coding_launches ADD COLUMN spec_dir TEXT;
-- `<pid>:<start time>` of the user manager when the launch was verified (design §5).
ALTER TABLE coding_launches ADD COLUMN manager TEXT;
ALTER TABLE coding_launches ADD COLUMN stop_cause TEXT;
-- 'eligible' or the reason the result may not be used (completeness, driver rules, stop cause).
ALTER TABLE coding_launches ADD COLUMN eligibility TEXT;
-- 1 while the launch's end could not be proven: the agent takes no new turn (the unit analogue of an unresolved group).
ALTER TABLE coding_launches ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
ALTER TABLE coding_launches ADD COLUMN deadline_at INTEGER;
CREATE INDEX coding_launches_agent ON coding_launches (agent_id);
