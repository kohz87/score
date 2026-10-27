-- 3.7.12 (owner): a team-room job that started a run whose room was deleted stayed in the Threads list. Deleting the
-- run's room now deletes that job too (room-delete.ts); this does it once for the jobs already left behind, as a job
-- delete does (messages and job marked deleted, so Undo could still restore them). Only jobs whose run AND run room are
-- both gone: a run the daily retention pruned keeps its room (`room-<run id>`) and its job.
UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE deleted_at IS NULL AND job_id IN (
  SELECT id FROM jobs WHERE recipe_ref IS NOT NULL AND deleted_at IS NULL
    AND recipe_ref NOT IN (SELECT id FROM orchestrations)
    AND 'room-' || recipe_ref NOT IN (SELECT id FROM rooms)
);
UPDATE jobs SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1
WHERE recipe_ref IS NOT NULL AND deleted_at IS NULL
  AND recipe_ref NOT IN (SELECT id FROM orchestrations)
  AND 'room-' || recipe_ref NOT IN (SELECT id FROM rooms);
