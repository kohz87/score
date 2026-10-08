-- Content-addressed media (browser screenshots, composer attachments). The bytes live under $SCORE_HOME/media/
-- in a file named by sha256; this table is the index. refs counts messages that point at the item: only
-- unreferenced items are evicted when the store is over its quota.
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  size INTEGER NOT NULL CHECK (size > 0),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  refs INTEGER NOT NULL DEFAULT 0 CHECK (refs >= 0)
) STRICT;
CREATE INDEX media_eviction ON media (refs, last_used_at);
