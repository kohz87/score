-- 3.14–3.16 (decision 150): the advisor, helpers and votes. Who advises a job and its helpers' settings; which steps are
-- Score's consults ('advisor'), helper work ('helper', with its role) or vote answers ('vote', with their vote); the
-- checkpoint, failure signature and reason of a consult; and each vote with its tally.
ALTER TABLE orchestrations ADD COLUMN advisor_agent_id TEXT;
ALTER TABLE orchestrations ADD COLUMN helpers_json TEXT;
ALTER TABLE orc_steps ADD COLUMN role TEXT CHECK (role IS NULL OR role IN ('advisor', 'helper', 'vote'));
ALTER TABLE orc_steps ADD COLUMN checkpoint TEXT;
ALTER TABLE orc_steps ADD COLUMN signature TEXT;
ALTER TABLE orc_steps ADD COLUMN reason TEXT;
ALTER TABLE orc_steps ADD COLUMN helper_role TEXT;
ALTER TABLE orc_steps ADD COLUMN vote_id TEXT;
CREATE TABLE orc_votes (
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id),
  id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL CHECK (json_valid(options)),
  k INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('voting', 'sharp', 'split', 'failed')),
  counts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(counts)),
  choice INTEGER,
  share REAL,
  inquiry_id TEXT,
  created_in_attempt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  tallied_at TEXT,
  PRIMARY KEY (orchestration_id, id)
);
