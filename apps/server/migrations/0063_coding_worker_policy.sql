-- 7.7b part 2 (design v6 §§3, 4, 8, 12a): the worker policy each coding worker of a run was approved with, the run's
-- coding step limit and the unknown-cost sources the person accepted.
--
-- The policy is the canonical JSON the person's `policyId` is the hash of. Its values are identities and hashes only:
-- environment values and configuration contents are never stored (a snapshot stays well under 4 KB).
CREATE TABLE orc_worker_policies (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  agent_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy TEXT NOT NULL,
  -- The reach in plain words, and whether it goes beyond the workspace (the person had to acknowledge it).
  reach TEXT NOT NULL,
  reach_beyond_workspace INTEGER NOT NULL CHECK (reach_beyond_workspace IN (0, 1)),
  -- The acknowledgement covers this exact policy id; an old one never carries over to a new id.
  acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (orchestration_id, agent_id)
) STRICT;

-- How many coding launches the run may release; the count itself is derived from the coding journal (M4).
ALTER TABLE orchestrations ADD COLUMN coding_steps INTEGER NOT NULL DEFAULT 10;
-- Sources (`hermes`, `claude-code`, `codex`) whose unknown cost the person accepted, as a JSON array.
ALTER TABLE orchestrations ADD COLUMN accepted_unknown_cost TEXT NOT NULL DEFAULT '[]';
-- The policy id an attempt was admitted with (a suspended attempt is admitted again under the new one).
ALTER TABLE orc_attempts ADD COLUMN policy_id TEXT;
