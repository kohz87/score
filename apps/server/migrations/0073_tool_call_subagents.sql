-- PLAN 8.7: coding agents' sub-agents. `call_id` is the CLI's own tool call id, `parent_call_id` the Agent call a
-- sub-agent's call ran under, `subagent` the JSON summary (status, counts) written on the Agent row only.
-- Old rows keep NULL and render flat.
ALTER TABLE tool_calls ADD COLUMN call_id TEXT;
ALTER TABLE tool_calls ADD COLUMN parent_call_id TEXT;
ALTER TABLE tool_calls ADD COLUMN subagent TEXT;
