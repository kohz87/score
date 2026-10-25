-- 2.3.0 (decision 128): an agent's clarify question to the person on a Score run, and the successor of a Hermes
-- session that was deleted (0.22.5 never lets a deleted session id be used again).
CREATE TABLE agent_questions (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  run_id TEXT NOT NULL,
  -- Hermes' prompt id and the run's execution generation, both needed to answer.
  prompt_id TEXT NOT NULL,
  generation INTEGER,
  room_id TEXT,
  job_id TEXT,
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  multi_select INTEGER NOT NULL DEFAULT 0 CHECK (multi_select IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'expired', 'withdrawn')),
  -- JSON: a string or an array of strings.
  answer TEXT,
  answered_by TEXT CHECK (answered_by IN ('you', 'elsewhere', 'timeout')),
  delivery TEXT NOT NULL DEFAULT 'none' CHECK (delivery IN ('none', 'delivering', 'applied', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  answered_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, prompt_id)
) STRICT;
CREATE INDEX agent_questions_pending ON agent_questions (status, room_id);

CREATE TABLE session_successors (
  agent_id TEXT NOT NULL,
  -- The id Hermes refused (session_deleted) and the one Score uses from then on.
  retired_session_id TEXT NOT NULL,
  successor_session_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, retired_session_id)
) STRICT;
