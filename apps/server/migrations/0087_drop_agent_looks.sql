-- migrate: foreign_keys=off
-- PLAN 11.11 (decision 118): pet packs, cut-out and ring looks are gone; an agent is its colour and shape. The columns
-- from 0078 (agent_styles / coding_agents: look, pack_rev, pack_meta) stay but are unused from 11.11. They are kept
-- rather than dropped because dropping `look` would mean another rebuild around 0078's CHECK; this rebuild is needed
-- anyway to let `look` be NULL. The pack files under $SCORE_HOME/packs are removed by the operator at deploy, never by
-- code. Forward-only and idempotent (clearing NULLs again changes nothing).
CREATE TABLE agent_styles_new (
  agent_id TEXT PRIMARY KEY,
  color TEXT NOT NULL,
  shape TEXT NOT NULL CHECK (shape IN ('circle-dot','triangle','diamond','square','hexagon','star','pill','cross',
    'cloud','cylinder','heart','drop','bolt','moon','leaf','blob','shield','octagon','bubble','gem')),
  -- Unused from 11.11; NULL means no look.
  look TEXT CHECK (look IS NULL OR look IN ('cut','ring')),
  -- Unused from 11.11; the revision of the removed pack.
  pack_rev TEXT,
  -- Unused from 11.11; the manifest of the removed pack.
  pack_meta TEXT,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO agent_styles_new (agent_id, color, shape, look, pack_rev, pack_meta, updated_at)
  SELECT agent_id, color, shape, look, pack_rev, pack_meta, updated_at FROM agent_styles;
DROP TABLE agent_styles;
ALTER TABLE agent_styles_new RENAME TO agent_styles;

-- A coding agent keeps its style in its own row. The same three columns stay and are cleared; every other column and
-- constraint is copied exactly.
CREATE TABLE coding_agents_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL CHECK (runtime IN ('claude-code', 'codex', 'antigravity', 'opencode')),
  workspace TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read-only', 'workspace-write', 'full')),
  model TEXT,
  color TEXT NOT NULL,
  shape TEXT NOT NULL,
  confirmed_version TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT,
  quota_floor_percent INTEGER NOT NULL DEFAULT 10 CHECK (quota_floor_percent BETWEEN 0 AND 50),
  instructions TEXT NOT NULL DEFAULT '',
  -- Unused from 11.11; NULL means no look.
  look TEXT CHECK (look IS NULL OR look IN ('cut','ring')),
  -- Unused from 11.11; the revision of the removed pack.
  pack_rev TEXT,
  -- Unused from 11.11; the manifest of the removed pack.
  pack_meta TEXT
) STRICT;
INSERT INTO coding_agents_new (
  id, name, role, runtime, workspace, permission, model, color, shape, confirmed_version, created_at, removed_at,
  quota_floor_percent, instructions, look, pack_rev, pack_meta
)
  SELECT id, name, role, runtime, workspace, permission, model, color, shape, confirmed_version, created_at,
    removed_at, quota_floor_percent, instructions, look, pack_rev, pack_meta
  FROM coding_agents;
DROP TABLE coding_agents;
ALTER TABLE coding_agents_new RENAME TO coding_agents;

-- The requested removal: both tables keep the columns, but nothing uses them from 11.11. Running it again changes nothing.
UPDATE agent_styles SET look = NULL, pack_rev = NULL, pack_meta = NULL;
UPDATE coding_agents SET look = NULL, pack_rev = NULL, pack_meta = NULL;
