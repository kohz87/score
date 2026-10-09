-- A rewind command whose answer never came may still be claimed by the plugin; its room stays held until the command
-- has provably expired (audit5-e), also across a Score restart.
CREATE TABLE rewind_holds (
  room_id TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL
) STRICT;
