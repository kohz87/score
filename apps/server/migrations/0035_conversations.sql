-- Conversations (PLAN 5.26): organise rooms, search message text, share links, imported outside sessions.

-- Organising rooms: Score-side only. A room belongs to at most one project.
CREATE TABLE room_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

ALTER TABLE rooms ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
ALTER TABLE rooms ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
ALTER TABLE rooms ADD COLUMN project_id TEXT REFERENCES room_projects(id);
-- null = tags follow the room name's #hashtags; a JSON array = set explicitly.
ALTER TABLE rooms ADD COLUMN tags TEXT CHECK (tags IS NULL OR json_valid(tags));
-- Set on a room made from a Hermes session that Score did not start: {agentId, sessionId, source, label}.
ALTER TABLE rooms ADD COLUMN imported_from TEXT CHECK (imported_from IS NULL OR json_valid(imported_from));

-- Message search: plain text parts of finished, undeleted messages. rowid = messages.rowid, kept in step by triggers
-- so every writer (ingest, retry, delete, edit) is covered. A streaming reply is indexed when it completes.
CREATE VIRTUAL TABLE message_fts USING fts5(
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER message_fts_insert AFTER INSERT ON messages
WHEN NEW.streaming = 0 AND NEW.deleted_at IS NULL
BEGIN
  INSERT INTO message_fts (rowid, body) VALUES (
    NEW.rowid,
    (SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(NEW.parts)
      WHERE json_extract(value, '$.kind') = 'text')
  );
END;

CREATE TRIGGER message_fts_update AFTER UPDATE OF parts, streaming, deleted_at ON messages
BEGIN
  DELETE FROM message_fts WHERE rowid = OLD.rowid;
  INSERT INTO message_fts (rowid, body)
  SELECT NEW.rowid,
    (SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(NEW.parts)
      WHERE json_extract(value, '$.kind') = 'text')
  WHERE NEW.streaming = 0 AND NEW.deleted_at IS NULL;
END;

CREATE TRIGGER message_fts_delete AFTER DELETE ON messages
BEGIN
  DELETE FROM message_fts WHERE rowid = OLD.rowid;
END;

INSERT INTO message_fts (rowid, body)
SELECT rowid,
  (SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(messages.parts)
    WHERE json_extract(value, '$.kind') = 'text')
FROM messages WHERE streaming = 0 AND deleted_at IS NULL;

-- Share links: a frozen, redacted, text-only snapshot. Only the SHA-256 of the token is stored.
CREATE TABLE room_shares (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  include_images INTEGER NOT NULL CHECK (include_images IN (0, 1)),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
) STRICT;
CREATE INDEX room_shares_room ON room_shares (room_id);

-- Which Hermes session a room's turns for one agent go into (imported rooms that continue their session).
CREATE TABLE room_sessions (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  -- 'same_session': turns go into the imported Hermes session. 'new_session': a fresh session that starts with
  -- `summary`, sent with the room's first turn only.
  mode TEXT NOT NULL CHECK (mode IN ('same_session', 'new_session')),
  summary TEXT,
  summary_sent INTEGER NOT NULL DEFAULT 0 CHECK (summary_sent IN (0, 1)),
  PRIMARY KEY (room_id, agent_id)
) STRICT;
