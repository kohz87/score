CREATE TABLE profile_operations (
  id TEXT PRIMARY KEY,
  target_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (json_valid(operation)),
  request TEXT NOT NULL CHECK (json_valid(request)),
  target_identity TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'needs_attention', 'completed'))
) STRICT;
CREATE TABLE fake_profiles (name TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (json_valid(state))) STRICT;
CREATE UNIQUE INDEX profile_operation_lock ON profile_operations(target_name) WHERE state != 'completed';
CREATE TABLE agent_lifecycle (
  agent_id TEXT PRIMARY KEY,
  incarnation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('setting_up', 'ready', 'deleting', 'needs_attention', 'removed')),
  operation_id TEXT,
  display_name TEXT
) STRICT;
