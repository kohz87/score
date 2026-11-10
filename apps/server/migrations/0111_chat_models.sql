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
CREATE TRIGGER messages_reply_model AFTER INSERT ON messages
WHEN NEW.author_kind = 'agent'
BEGIN
  UPDATE messages SET model = (SELECT model FROM message_runs WHERE message_id = NEW.id) WHERE id = NEW.id;
END;
