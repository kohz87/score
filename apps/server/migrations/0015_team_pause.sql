-- Team-wide "Pause everyone": one flag (holds Score's dispatch queue for all agents) and the briefs this pause
-- paused, so "Resume everyone" only resumes those and never a brief the person paused on its own.
CREATE TABLE team_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused_at TEXT
) STRICT;
INSERT INTO team_state (id, paused_at) VALUES (1, NULL);

CREATE TABLE team_paused_briefs (
  brief_id TEXT PRIMARY KEY REFERENCES briefs(id)
) STRICT;
