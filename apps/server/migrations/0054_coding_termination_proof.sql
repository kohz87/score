-- Fix batch W (7.7 design review, findings 1-4). A coding run ends only with proof that its process group is gone.
-- 1. The boot each process was recorded in: start times and pids are per boot, so a row from another boot is gone.
-- 2. unresolved = 1: the group could not be proven gone (survived SIGKILL, or /proc could not tell). The row stays,
--    Score keeps trying in the background, and the agent takes no new turn while any such row remains.
ALTER TABLE coding_processes ADD COLUMN boot_id TEXT;
ALTER TABLE coding_processes ADD COLUMN unresolved INTEGER NOT NULL DEFAULT 0;

-- 3. terminal_source gains 'unconfirmed': the run ended and its reply is shown, but the group was not proven gone, so
--    it is not termination evidence. SQLite can't change a CHECK, so the column is rebuilt in place.
ALTER TABLE runs ADD COLUMN terminal_source_v2 TEXT CHECK (terminal_source_v2 IN ('runtime', 'recovered', 'unconfirmed'));
UPDATE runs SET terminal_source_v2 = terminal_source;
ALTER TABLE runs DROP COLUMN terminal_source;
ALTER TABLE runs RENAME COLUMN terminal_source_v2 TO terminal_source;
