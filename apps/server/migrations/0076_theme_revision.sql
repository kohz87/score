-- Phase 9 gate (#7): the If-Match etag of a theme must change with every byte of its package, assets and licence files
-- included. Every write of a theme row takes the next number of one counter that never goes back (deleting and
-- re-creating a theme can't produce an etag an older reader still holds).
ALTER TABLE themes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO meta (key, value) VALUES ('themes.revision', '0');

-- Phase 9 gate (#11, #12): a folder swap or id move is written down here before any file moves and erased in the same
-- transaction that commits the theme row, so a row present at start means "interrupted before the commit". The chosen
-- ids are in the row: recovery follows them and never guesses from which folders exist.
CREATE TABLE theme_swaps (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('swap', 'reclaim')),
  theme_id TEXT NOT NULL,
  other_id TEXT,
  had_folder INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
