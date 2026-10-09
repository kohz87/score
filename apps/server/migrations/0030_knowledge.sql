-- Knowledge index (PLAN 6.2). The vault's files are the source of truth; these tables are disposable and rebuilt by
-- the scanner. Only the settings row is state of its own.
CREATE TABLE knowledge_notes (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL,
  -- 'you' | 'outside' | 'agent:<id>' | NULL (unknown)
  last_author TEXT
) STRICT;

CREATE TABLE knowledge_links (
  from_path TEXT NOT NULL,
  to_target TEXT NOT NULL,
  to_path TEXT
) STRICT;
CREATE INDEX knowledge_links_from ON knowledge_links (from_path);
CREATE INDEX knowledge_links_to ON knowledge_links (to_path);

-- rowid = knowledge_notes.id, so a note's row is replaced without scanning the table.
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  path UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE knowledge_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  agent_access INTEGER NOT NULL CHECK (agent_access IN (0, 1))
) STRICT;
INSERT INTO knowledge_settings (id, agent_access) VALUES (1, 1);
