-- "Pause <agent>" (Watch): holds Score's dispatch queue for one agent and blocks its not-started Kanban tasks.
-- agent_paused_tasks records what Score blocked so Resume unblocks only those.
CREATE TABLE agent_pauses (
  agent_id TEXT PRIMARY KEY,
  paused_at TEXT NOT NULL
) STRICT;

CREATE TABLE agent_paused_tasks (
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  blocked_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, task_id)
) STRICT;
