-- PLAN 8.2: Settings › Knowledge › "Save compacted summaries as memory notes" (on by default).
ALTER TABLE knowledge_settings ADD COLUMN memory_notes INTEGER NOT NULL DEFAULT 1 CHECK (memory_notes IN (0, 1));
