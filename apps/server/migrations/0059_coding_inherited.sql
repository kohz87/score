-- 7.7a fix round FY2: a launch whose journal records were copied from another installation (confirm-copy) is evidence
-- only. The journal's `inherited` flag is projected here so the runtime never stops, resets or recovers such a launch.
ALTER TABLE coding_launches ADD COLUMN inherited INTEGER NOT NULL DEFAULT 0;
