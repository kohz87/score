-- PLAN 11.6a: review notes pinned to lines of files a job changed, from the review / approve / send_back actions'
-- optional `comments`. Positions are the ones the agent wrote them on; the Workbench moves them with later edits on read.
CREATE TABLE review_comments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  exchange_id TEXT,
  turn_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('review', 'approve', 'send_back')),
  path TEXT NOT NULL,
  line INTEGER NOT NULL CHECK (line > 0),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX review_comments_job ON review_comments (job_id, created_at);
