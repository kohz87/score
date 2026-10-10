-- Knowledge documents (PLAN 6.6): uploaded files in the vault that are not Markdown notes. Like the note index this
-- is disposable (the scanner rebuilds it from the files); extracted text lives only in the FTS table.
CREATE TABLE knowledge_documents (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  -- 1 when committed to the vault's git (files up to 10 MB), 0 when only stored
  versioned INTEGER NOT NULL CHECK (versioned IN (0, 1)),
  -- 'indexed' | 'truncated' | 'unavailable' | 'none'
  text_status TEXT NOT NULL,
  -- zip files: JSON array of {path, size}, otherwise NULL
  entries_json TEXT,
  last_author TEXT
) STRICT;

-- rowid = knowledge_documents.id
CREATE VIRTUAL TABLE knowledge_doc_fts USING fts5(
  path UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
