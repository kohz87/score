-- migrate: foreign_keys=off
-- PLAN 10.2 (decisions 105-108): 20 shapes, an agent look (cut-out or ring mark) and an uploaded pet pack. SQLite cannot
-- change a CHECK in place, so agent_styles is rebuilt; every stored style is kept, with the default look and no pack.
CREATE TABLE agent_styles_new (
  agent_id TEXT PRIMARY KEY,
  color TEXT NOT NULL,
  shape TEXT NOT NULL CHECK (shape IN ('circle-dot','triangle','diamond','square','hexagon','star','pill','cross',
    'cloud','cylinder','heart','drop','bolt','moon','leaf','blob','shield','octagon','bubble','gem')),
  look TEXT NOT NULL DEFAULT 'cut' CHECK (look IN ('cut','ring')),
  -- The revision of the agent's pet pack ($SCORE_HOME/packs/<agent_id>/<pack_rev>/<activity>.<ext>); NULL = none.
  pack_rev TEXT,
  -- The pack's activities, name, credits and floor (JSON, PetPack without the revision); read back through the contract.
  pack_meta TEXT,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO agent_styles_new (agent_id, color, shape, updated_at)
  SELECT agent_id, color, shape, updated_at FROM agent_styles;
DROP TABLE agent_styles;
ALTER TABLE agent_styles_new RENAME TO agent_styles;

-- A coding agent keeps its style in its own row (its shape was never constrained). A style once changed through the
-- agent_styles override moves into the row, so there is exactly one place per agent.
ALTER TABLE coding_agents ADD COLUMN look TEXT NOT NULL DEFAULT 'cut' CHECK (look IN ('cut','ring'));
ALTER TABLE coding_agents ADD COLUMN pack_rev TEXT;
ALTER TABLE coding_agents ADD COLUMN pack_meta TEXT;
UPDATE coding_agents SET
  color = (SELECT s.color FROM agent_styles s WHERE s.agent_id = coding_agents.id),
  shape = (SELECT s.shape FROM agent_styles s WHERE s.agent_id = coding_agents.id)
  WHERE id IN (SELECT agent_id FROM agent_styles);
DELETE FROM agent_styles WHERE agent_id IN (SELECT id FROM coding_agents);
