CREATE TABLE task_projections (
  id TEXT PRIMARY KEY,
  detail TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  incarnation TEXT
) STRICT;

-- Task details include bodies, checklists and activity; other routes retain the original 64 KB cap.
CREATE TABLE request_receipts_next (
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  status INTEGER,
  response TEXT CHECK (
    response IS NULL OR (
      json_valid(response) AND length(CAST(response AS BLOB)) <=
        CASE WHEN route = '/api/tasks' OR route LIKE '/api/tasks/%' THEN 524288 ELSE 65536 END
    )
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, route)
) STRICT;
INSERT INTO request_receipts_next SELECT * FROM request_receipts;
DROP TABLE request_receipts;
ALTER TABLE request_receipts_next RENAME TO request_receipts;
CREATE INDEX request_receipts_created ON request_receipts(created_at);
