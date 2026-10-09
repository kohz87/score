-- Soft delete (PLAN 5.20): a deleted message stays for runs and audit but leaves every read.
ALTER TABLE messages ADD COLUMN deleted_at TEXT;

CREATE INDEX messages_room_live ON messages (room_id, created_at, id) WHERE deleted_at IS NULL;
