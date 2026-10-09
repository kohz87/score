-- Every tool hook looks up the agent's last browser frame and the run for its session; without these the
-- lookups scan the agent's whole frame history / all of the profile's runs inside the ingest transaction.
CREATE INDEX watch_frames_browser ON watch_frames(agent_id, seq) WHERE surface = 'browser';
CREATE INDEX runs_profile_session ON runs(profile, session_id, started_at DESC);
