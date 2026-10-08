CREATE TABLE agent_styles (
  agent_id TEXT PRIMARY KEY,
  color TEXT NOT NULL,
  shape TEXT NOT NULL CHECK (shape IN ('circle-dot','triangle','diamond','square','hexagon','star','pill','cross')),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE agents_proj (
  id TEXT PRIMARY KEY,
  detail TEXT NOT NULL
) STRICT;
