-- PLAN 9.1 (decision 90): themes. Built-in themes are not rows (the server lists them from a constant); a row is an
-- imported or custom theme. Assets live on disk under $SCORE_HOME/themes/<id>/assets. The shared look is two rows in `meta`.
CREATE TABLE themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  css TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('imported', 'custom')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO meta (key, value) VALUES ('look.activeTheme', 'score');
INSERT OR IGNORE INTO meta (key, value) VALUES ('look.mode', 'system');
