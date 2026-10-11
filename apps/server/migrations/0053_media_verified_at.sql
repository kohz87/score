-- When the media sweep last re-hashed a row's blob. The sweep takes the least recently verified rows first, so a
-- store larger than one sweep's hash budget still gets every blob checked in turn (NULL = never, goes first).
ALTER TABLE media ADD COLUMN verified_at TEXT;
