-- SA.1 (DECISIONS 173): when a profile went inline. A Hermes session keeps the delegation mode it started with, so a
-- session Score already ran before this moment is still in background mode, and subagents stay off in it.
CREATE TABLE subagent_setup (
  profile TEXT PRIMARY KEY,
  inline_since TEXT NOT NULL
);
