-- 7.7c #4 (design §3): a workflow attempt's complete-reply facts join by (attempt, generation), not by the attempt alone.
-- A coding attempt has one dispatch generation per launch; a late result of an earlier generation can never replace the
-- current generation's row, and the planner reads the row of the generation that is current. Hermes attempts keep
-- generation 0. `too_long` marks a reply over the verdict input limit: such a node fails, a prefix is never parsed.
CREATE TABLE wf_results_next (
  attempt_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  verdict TEXT CHECK (verdict IS NULL OR json_valid(verdict)),
  output TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  full_bytes INTEGER NOT NULL DEFAULT 0,
  too_long INTEGER NOT NULL DEFAULT 0 CHECK (too_long IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, generation)
) STRICT;
INSERT INTO wf_results_next (attempt_id, generation, verdict, output, truncated, full_bytes, created_at)
  SELECT attempt_id, 0, verdict, output, truncated, full_bytes, created_at FROM wf_results;
DROP TABLE wf_results;
ALTER TABLE wf_results_next RENAME TO wf_results;
