-- Holds recorded before pauses parked tasks as 'scheduled' parked them as 'blocked'. Resume must still unblock those,
-- so every hold that exists now is marked legacy (new holds default to 0).
ALTER TABLE brief_paused_tasks ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_paused_tasks ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0;
UPDATE brief_paused_tasks SET legacy = 1;
UPDATE agent_paused_tasks SET legacy = 1;
