-- A rewind command whose answer never came may still be claimed by the plugin; its room stays held until the command
-- has provably expired (audit5-e), also across a Score restart.
CREATE TABLE rewind_holds (
  room_id TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL
) STRICT;

-- A run admitted for a reply that was cancelled meanwhile is stopped until Hermes confirms it: NULL = nothing owed,
-- 'pending' = the stop is owed (it survives a failed request or a restart), 'done' = confirmed.
ALTER TABLE command_intents ADD COLUMN stop_state TEXT CHECK (stop_state IN ('pending', 'done'));
