-- migrate: foreign_keys=off
-- 2.2.0 (decision 127): two more shapes, ball and flower, from the owner's "agents with eyes" mock-up. SQLite cannot
-- change a CHECK in place, so agent_styles is rebuilt exactly as 0078 left it (the unused look/pack columns of 0087
-- included) with the two shapes added; every row is kept. coding_agents never constrained its shape.
CREATE TABLE agent_styles_new (
  agent_id TEXT PRIMARY KEY,
  color TEXT NOT NULL,
  shape TEXT NOT NULL CHECK (shape IN ('circle-dot','triangle','diamond','square','hexagon','star','pill','cross',
    'cloud','cylinder','heart','drop','bolt','moon','leaf','blob','shield','octagon','bubble','gem','ball','flower')),
  look TEXT NOT NULL DEFAULT 'cut' CHECK (look IN ('cut','ring')),
  pack_rev TEXT,
  pack_meta TEXT,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO agent_styles_new (agent_id, color, shape, look, pack_rev, pack_meta, updated_at)
  SELECT agent_id, color, shape, look, pack_rev, pack_meta, updated_at FROM agent_styles;
DROP TABLE agent_styles;
ALTER TABLE agent_styles_new RENAME TO agent_styles;
