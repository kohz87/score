-- Fix batch X (7.7 re-review N4, N5). Ownership of a process group whose leader is gone needs continuity, and an
-- unreadable /proc is not absence.
-- 1. Identities (pid + start time + boot) of group members, recorded while Score supervises the run. After the leader
--    is gone only these (and processes that descend from them) may be signalled.
CREATE TABLE coding_process_members (
  run_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  boot_id TEXT,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (run_id, pid, start_time)
);
-- 2. unobservable = 1: the last attempt could not tell whether what is left is ours (unreadable /proc, or a member
--    that matches no recorded identity). Only these groups can be released by the person.
ALTER TABLE coding_processes ADD COLUMN unobservable INTEGER NOT NULL DEFAULT 0;
-- 3. The audit trail of releases. Releasing never signals anything.
CREATE TABLE coding_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  pgid INTEGER NOT NULL,
  released_by TEXT NOT NULL,
  released_at TEXT NOT NULL
);
