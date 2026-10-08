-- Reserve turns before admission so run events can attach a reply before SSE starts.
CREATE TABLE message_runs (
  message_id TEXT PRIMARY KEY,
  run_id TEXT UNIQUE REFERENCES runs(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  agent_id TEXT NOT NULL,
  chain_id TEXT NOT NULL REFERENCES messages(id),
  hop INTEGER NOT NULL CHECK (hop BETWEEN 0 AND 4),
  turn_id TEXT NOT NULL UNIQUE,
  parent_message_id TEXT NOT NULL REFERENCES messages(id),
  from_agent_id TEXT,
  input TEXT NOT NULL,
  admission_input TEXT,
  model TEXT,
  agents TEXT NOT NULL CHECK (json_valid(agents)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'completed', 'failed')),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX message_runs_queue ON message_runs(state, room_id, agent_id, created_at);
CREATE INDEX message_runs_chain ON message_runs(chain_id);
