-- 0023 marked every hold it found as legacy (parked as 'blocked'). A hold still 'pending' was never confirmed parked by
-- Score, so the task may be blocked for an unrelated reason: Resume must not unblock it on the strength of that mark.
UPDATE brief_paused_tasks SET legacy = 0 WHERE state = 'pending';
UPDATE agent_paused_tasks SET legacy = 0 WHERE state = 'pending';
