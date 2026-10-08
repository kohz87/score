-- A pause records its intent ('pending') before parking the task in Hermes and confirms it ('held') afterwards,
-- so a crash or a refused park is retried instead of forgotten. Rows from before this migration were confirmed.
ALTER TABLE brief_paused_tasks ADD COLUMN state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('pending', 'held'));
ALTER TABLE agent_paused_tasks ADD COLUMN state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('pending', 'held'));
