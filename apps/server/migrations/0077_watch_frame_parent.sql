-- C1: a coding agent's sub-agent step keeps the Agent call it ran under, so Watch groups by id instead of by caption.
-- Old rows keep NULL and fall back to the caption prefix.
ALTER TABLE watch_frames ADD COLUMN parent_call_id TEXT;
