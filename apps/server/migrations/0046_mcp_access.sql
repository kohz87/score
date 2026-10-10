-- Score as an MCP server for its agents (PLAN 7.4d). One row per agent; no row = everything off.
-- token_hash is the SHA-256 (hex) of the bearer token, which is shown once and never stored.
CREATE TABLE mcp_access (
  agent_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  writes_enabled INTEGER NOT NULL DEFAULT 0 CHECK (writes_enabled IN (0, 1)),
  -- The agent_lifecycle incarnation the switches and token were issued for; a different one never inherits them.
  incarnation_id TEXT,
  token_hash TEXT UNIQUE,
  token_created_at INTEGER
) STRICT;

-- One row per MCP post (rooms.post, tasks.comment): the hourly rate limit and the audit trail. at = epoch ms.
CREATE TABLE mcp_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX mcp_posts_agent_at ON mcp_posts (agent_id, at);
