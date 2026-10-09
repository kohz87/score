-- Opt-in summaries of long rooms (PLAN 7.4a). NULL = off (the default); otherwise {"enabled":…,"thresholdTokens":…}.
ALTER TABLE rooms ADD COLUMN auto_summary TEXT;

-- 'summary' marks a run that writes the room summary instead of answering a message; its parent_message_id is the
-- newest message the summary covers.
ALTER TABLE message_runs ADD COLUMN purpose TEXT CHECK (purpose IN ('summary'));
