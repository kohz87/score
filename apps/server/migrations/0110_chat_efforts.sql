-- 3.33.0 (DECISIONS 178): an agent's effort in one chat, winning over its own setting there.
CREATE TABLE chat_efforts (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  effort TEXT NOT NULL,
  set_at TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);
-- The effort a turn ran at, and its reply's label ("builder · effort high"). The reply is created after the turn is
-- reserved, so it copies the turn's value as it's inserted.
ALTER TABLE message_runs ADD COLUMN effort TEXT;
ALTER TABLE messages ADD COLUMN effort TEXT;
CREATE TRIGGER messages_reply_effort AFTER INSERT ON messages
WHEN NEW.author_kind = 'agent'
BEGIN
  UPDATE messages SET effort = (SELECT effort FROM message_runs WHERE message_id = NEW.id) WHERE id = NEW.id;
END;
