-- 3.14 (decision 150): the advisor. Who it is for a job, and which steps are its consults (Score's, not the lead's): the
-- checkpoint that asked and, for a repeated failure, the normalised failure it was about (asked once per failure).
ALTER TABLE orchestrations ADD COLUMN advisor_agent_id TEXT;
ALTER TABLE orc_steps ADD COLUMN role TEXT CHECK (role IS NULL OR role = 'advisor');
ALTER TABLE orc_steps ADD COLUMN checkpoint TEXT;
ALTER TABLE orc_steps ADD COLUMN signature TEXT;
ALTER TABLE orc_steps ADD COLUMN reason TEXT;
