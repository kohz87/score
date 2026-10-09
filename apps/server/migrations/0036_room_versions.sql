-- Rewind (PLAN 5.33): editing or deleting the person's message X hides X and everything after it as a previous
-- version of the room. Hidden messages also carry deleted_at, so every existing read leaves them out.
CREATE TABLE room_versions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  anchor_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  mode TEXT NOT NULL CHECK (mode IN ('edit', 'delete')),
  score_only INTEGER NOT NULL DEFAULT 0 CHECK (score_only IN (0, 1)),
  hidden_count INTEGER NOT NULL,
  rewound TEXT NOT NULL CHECK (json_valid(rewound)),
  skipped TEXT NOT NULL CHECK (json_valid(skipped)),
  replaced_by TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX room_versions_room ON room_versions(room_id, created_at);
ALTER TABLE messages ADD COLUMN version_id TEXT;
CREATE INDEX messages_version ON messages(version_id) WHERE version_id IS NOT NULL;
-- Set once the agent's Hermes session was rewound past this turn, so a later rewind never counts it twice.
ALTER TABLE message_runs ADD COLUMN rewound_at TEXT;
