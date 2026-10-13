-- 7.7a sixth fix round FU (decision 72): the history generation `scripts/score installation reset-history` stored here
-- in the same step as the retirement. The execution journal carries the same generation; a database that doesn't match
-- it (a backup from before the reset) is frozen at start.
ALTER TABLE orc_global ADD COLUMN history_generation TEXT;
