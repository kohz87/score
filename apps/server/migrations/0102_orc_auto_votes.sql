-- 3.14 (owner, 2026-10-28: "we should make both automatic"): a vote Score starts on a step before it runs ("is this the
-- right agent and approach?") names that step; the step waits for the tally.
ALTER TABLE orc_votes ADD COLUMN step_id TEXT;
