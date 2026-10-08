CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('room', 'direct')),
  lead_agent_id TEXT,
  members TEXT NOT NULL CHECK (json_valid(members)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;

CREATE UNIQUE INDEX rooms_direct_agent ON rooms (lead_agent_id) WHERE kind = 'direct';

CREATE TABLE room_reads (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  last_read_message_created_at TEXT NOT NULL,
  last_read_message_id TEXT NOT NULL
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('you', 'agent')),
  author_agent_id TEXT,
  "to" TEXT NOT NULL CHECK (json_valid("to")),
  parts TEXT NOT NULL CHECK (json_valid(parts)),
  refs TEXT NOT NULL CHECK (json_valid(refs)),
  streaming INTEGER NOT NULL CHECK (streaming IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((author_kind = 'you' AND author_agent_id IS NULL) OR
         (author_kind = 'agent' AND author_agent_id IS NOT NULL))
) STRICT;

CREATE INDEX messages_room_created_id ON messages (room_id, created_at, id);
