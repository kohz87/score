-- PLAN 10.11: who was busy in a room when its state was last sent, so room updates go out only when that set changes.
ALTER TABLE rooms ADD COLUMN active_agents TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(active_agents));
-- The replies still being written, for the busy-now query (a handful of rows next to millions of messages).
CREATE INDEX messages_streaming ON messages (room_id, author_agent_id)
  WHERE streaming = 1 AND deleted_at IS NULL AND author_kind = 'agent';
