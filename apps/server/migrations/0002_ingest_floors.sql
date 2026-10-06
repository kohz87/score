ALTER TABLE ingest_keys ADD COLUMN scope TEXT;
ALTER TABLE ingest_keys ADD COLUMN incarnation TEXT;
ALTER TABLE ingest_keys ADD COLUMN position INTEGER;
CREATE INDEX ingest_keys_position ON ingest_keys(source, scope, incarnation, position) WHERE position IS NOT NULL;
CREATE TABLE ingest_floors (
  source TEXT NOT NULL,
  scope TEXT NOT NULL,
  incarnation TEXT NOT NULL,        -- '' stands for a NULL incarnation (PK columns can't be NULL meaningfully)
  floor INTEGER NOT NULL,           -- every observation with position <= floor is a duplicate
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, scope, incarnation)
) STRICT;
