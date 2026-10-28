-- 3.14 (owner, 2026-10-28: "we should make both automatic"): a vote Score starts on a step before it runs ("is this the
-- right agent and approach?") names that step; the step waits for the tally.
ALTER TABLE orc_votes ADD COLUMN step_id TEXT;
-- 3.15 (decision 151): how the advisor helps: on call to the workers (a Claude Code worker gets it as a subagent it asks
-- itself) plus the lead's checkpoints, or the checkpoints only.
ALTER TABLE orchestrations ADD COLUMN advisor_mode TEXT NOT NULL DEFAULT 'on_call' CHECK (advisor_mode IN ('on_call', 'checkpoints'));
-- 3.15 (review): the advisor model a step's worker gets on call, decided once when the step is admitted (its input says
-- so); the launch reads this instead of deciding again.
ALTER TABLE orc_steps ADD COLUMN advisor_model TEXT;
