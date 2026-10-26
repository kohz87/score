-- 3.6.0 (decision 137): the team room a trigger's jobs start in. NULL = the first (everyone) team room; deleting a team
-- room sets its triggers back to NULL in the same transaction.
ALTER TABLE triggers ADD COLUMN team_room_id TEXT;
