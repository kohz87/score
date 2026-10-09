-- Reasoning text of a run (PLAN 5.25): redacted and bounded before it is stored, shown as a collapsed thinking part.
CREATE TABLE run_thinking (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,              -- upstream seq of reasoning.available
  text TEXT NOT NULL,                -- redacted, bounded
  PRIMARY KEY (run_id, seq)
) STRICT;
