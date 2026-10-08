ALTER TABLE command_intents ADD COLUMN first_sent_at TEXT;
-- Legacy uncertain admissions use their creation time as a conservative replay bound.
UPDATE command_intents SET first_sent_at = created_at WHERE state != 'pending';
CREATE TABLE request_receipts (
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  status INTEGER,
  response TEXT CHECK (response IS NULL OR (json_valid(response) AND length(CAST(response AS BLOB)) <= 65536)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, route)
) STRICT;
CREATE INDEX request_receipts_created ON request_receipts(created_at);
-- Gateway approvals now need a qualified producer build (gate review #2): every producer re-qualifies at its next hello.
UPDATE producers SET gateway_approvals = 0;
