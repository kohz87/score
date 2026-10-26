-- 2.4.0 (decision 130): "Try another reply". A reply written again for the same message (Retry or Try another) names
-- the first reply of its group, so the room shows the versions as one bubble with a pager. The turn carries it until
-- its message is stored.
ALTER TABLE message_runs ADD COLUMN alternative_of TEXT;
ALTER TABLE messages ADD COLUMN alternative_of TEXT;
