-- Phase 9 gate (#7): the If-Match etag of a theme must change with every byte of its package, assets and licence files
-- included. Every write of a theme row takes the next number of one counter that never goes back (deleting and
-- re-creating a theme can't produce an etag an older reader still holds).
ALTER TABLE themes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO meta (key, value) VALUES ('themes.revision', '0');
