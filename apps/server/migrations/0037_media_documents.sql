-- Media now also holds attached documents (PLAN 5.30): the type list moves from a CHECK to the application, which
-- validates every row it reads. SQLite cannot drop a CHECK in place, so the table is rebuilt.
CREATE TABLE media_new (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 3 AND 128),
  size INTEGER NOT NULL CHECK (size > 0),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  refs INTEGER NOT NULL DEFAULT 0 CHECK (refs >= 0)
) STRICT;
INSERT INTO media_new SELECT id, sha256, content_type, size, created_at, last_used_at, refs FROM media;
DROP TABLE media;
ALTER TABLE media_new RENAME TO media;
CREATE INDEX media_eviction ON media (refs, last_used_at);
