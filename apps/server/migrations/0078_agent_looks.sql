-- migrate: foreign_keys=off
-- PLAN 10.2 (decision 105): 20 shapes, an agent look (bot or chibi) and an imported picture revision. SQLite cannot change a
-- CHECK in place, so agent_styles is rebuilt; every stored style is kept, with the default look and no picture.
CREATE TABLE agent_styles_new (
  agent_id TEXT PRIMARY KEY,
  color TEXT NOT NULL,
  shape TEXT NOT NULL CHECK (shape IN ('circle-dot','triangle','diamond','square','hexagon','star','pill','cross',
    'cloud','cylinder','heart','drop','bolt','moon','leaf','blob','shield','octagon','bubble','gem')),
  look TEXT NOT NULL DEFAULT 'bot' CHECK (look IN ('bot','chibi')),
  -- The revision of the imported picture ($SCORE_HOME/avatars/<agent_id>/<avatar_rev>.<ext>); NULL = none.
  avatar_rev TEXT,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO agent_styles_new (agent_id, color, shape, updated_at)
  SELECT agent_id, color, shape, updated_at FROM agent_styles;
DROP TABLE agent_styles;
ALTER TABLE agent_styles_new RENAME TO agent_styles;

-- A coding agent keeps its style in its own row (its shape was never constrained). A style once changed through the
-- agent_styles override moves into the row, so there is exactly one place per agent.
ALTER TABLE coding_agents ADD COLUMN look TEXT NOT NULL DEFAULT 'bot' CHECK (look IN ('bot','chibi'));
ALTER TABLE coding_agents ADD COLUMN avatar_rev TEXT;
UPDATE coding_agents SET
  color = (SELECT s.color FROM agent_styles s WHERE s.agent_id = coding_agents.id),
  shape = (SELECT s.shape FROM agent_styles s WHERE s.agent_id = coding_agents.id)
  WHERE id IN (SELECT agent_id FROM agent_styles);
DELETE FROM agent_styles WHERE agent_id IN (SELECT id FROM coding_agents);
