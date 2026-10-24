-- PLAN 11.2 (docs/briefs/11.2-contract.md): a room's pinned decisions. Their text goes into every turn in the room.
CREATE TABLE room_pins (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (room_id, message_id)
) STRICT;

-- A job's results read its runs' watch frames (PLAN 11.2b).
CREATE INDEX watch_frames_run ON watch_frames (run_id) WHERE run_id IS NOT NULL;
