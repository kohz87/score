-- 3.7.8 (decision 139): the tool names Score last handed an agent's Hermes on `tools/list`, and when. Hermes keeps that
-- list per connection, so it is what the agent can call until it reloads MCP; preflight's tool_readiness reads it. A new
-- or revoked token clears it (the agent has to connect again).
ALTER TABLE mcp_access ADD COLUMN listed_tools TEXT;
ALTER TABLE mcp_access ADD COLUMN listed_at INTEGER;
