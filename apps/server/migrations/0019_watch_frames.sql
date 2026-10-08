-- Watch replay frames (ARCHITECTURE D6). Everything stored here has been redacted twice (plugin, then server).
CREATE TABLE watch_frames (
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,              -- per agent, strictly increasing; a terminal frame is updated in place (running -> ok/error)
  at TEXT NOT NULL,
  run_id TEXT,
  surface TEXT NOT NULL CHECK (surface IN ('terminal','editor','browser')),
  payload TEXT NOT NULL,             -- redacted JSON of the surface payload (terminal | editor | browser)
  caption TEXT NOT NULL,
  marker_kind TEXT CHECK (marker_kind IN ('command','file','browser','asked')),
  call_key TEXT,                     -- <session>:<tool_call_id>[#n]; lets the post hook update the pre hook's frame
  PRIMARY KEY (agent_id, seq)
) STRICT;
CREATE UNIQUE INDEX watch_frames_call ON watch_frames(agent_id, call_key) WHERE call_key IS NOT NULL;
CREATE INDEX watch_frames_at ON watch_frames(at);
