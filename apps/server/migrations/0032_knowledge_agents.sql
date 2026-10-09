-- Per-agent switch for the knowledge tools (Team › agent › Tools). No row = enabled; the global switch
-- (knowledge_settings.agent_access) is checked first.
CREATE TABLE knowledge_agent_access (
  agent_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
) STRICT;

-- One row per agent write (rate limit: 60/hour/agent; Settings › Knowledge shows today's counts). at = epoch ms.
CREATE TABLE knowledge_agent_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX knowledge_agent_writes_agent_at ON knowledge_agent_writes (agent_id, at);
