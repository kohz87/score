-- 3.28.0 (DECISIONS 164): one job per group chat. A trigger call that arrives while its team room has a job running
-- waits here ("Next up") and starts when that job ends; the person can skip it. `opening` is the already redacted
-- message the lead gets; `source` the job's JSON source, as on jobs.source.
CREATE TABLE room_queue (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  opening TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (trigger_id, webhook_id)
);
-- Oldest first is the insert order (rowid): calls in the same millisecond keep their order.
CREATE INDEX room_queue_room ON room_queue (room_id);
