-- audit4-c #1 (S4-004): a share owns the images it names. One row per (share, media); the row stands for one media
-- reference, released exactly once when the share is revoked, cleaned up after expiry, or deleted with its room.
CREATE TABLE share_media (
  share_id TEXT NOT NULL REFERENCES room_shares(id),
  media_id TEXT NOT NULL,
  PRIMARY KEY (share_id, media_id)
) STRICT;
CREATE INDEX share_media_media ON share_media (media_id);

-- Existing live shares (not revoked, not yet expired) take their references now.
INSERT OR IGNORE INTO share_media (share_id, media_id)
SELECT DISTINCT s.id, j.value
  FROM room_shares s, json_each(s.snapshot, '$.images') j
 WHERE s.include_images = 1 AND s.revoked_at IS NULL
   AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   AND j.type = 'text'
   AND EXISTS (SELECT 1 FROM media m WHERE m.id = j.value);

UPDATE media
   SET refs = refs + (SELECT COUNT(*) FROM share_media sm WHERE sm.media_id = media.id)
 WHERE id IN (SELECT media_id FROM share_media);
