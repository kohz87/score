-- Which Chat room a task was created from. Hermes has no such field; Score owns the association and merges it
-- into the live task projection (task ids are Hermes's, so no foreign key).
CREATE TABLE task_rooms (
  task_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
