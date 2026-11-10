-- 3.35.0 (DECISIONS 182): an agent's model in one chat, winning over its own model there and nowhere else.
CREATE TABLE chat_models (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT,
  label TEXT NOT NULL,
  set_at TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);
-- The model a turn was asked to run on (message_runs.model: a chat's /model or Try another) labels its reply
-- ("builder · example-large · effort high"). The reply is created after the turn is reserved, so it copies the turn's
-- value as it's inserted.
ALTER TABLE messages ADD COLUMN model TEXT;
-- Set once the chat's model has been decided for a turn, even when that is the agent's own (model stays NULL): a retry
-- copies it, so it runs as the turn it repeats did rather than on a model the chat chose later.
ALTER TABLE message_runs ADD COLUMN model_chosen INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER messages_reply_model AFTER INSERT ON messages
WHEN NEW.author_kind = 'agent'
BEGIN
  UPDATE messages SET model = (SELECT model FROM message_runs WHERE message_id = NEW.id) WHERE id = NEW.id;
END;
-- A deleted chat takes its overrides with it (model and effort). An agent taken out of a chat loses its overrides when
-- the room changes (roomChanged), which also tells the chat.
CREATE TRIGGER rooms_delete_drop_overrides AFTER DELETE ON rooms
BEGIN
  DELETE FROM chat_models WHERE room_id = OLD.id;
  DELETE FROM chat_efforts WHERE room_id = OLD.id;
END;
