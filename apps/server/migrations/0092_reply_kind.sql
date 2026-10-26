-- 3.5.0: which agent replies can be retried (Retry, Try another). A reply to the person's own message (hop 0, not a
-- hand-off, not a purpose or orchestration turn) is 'person'; any other reply with a run is 'handoff'; NULL = unknown
-- (no run recorded), where the web keeps today's behaviour and the server still decides.
ALTER TABLE messages ADD COLUMN reply_kind TEXT CHECK (reply_kind IN ('person', 'handoff'));
UPDATE messages SET reply_kind = (
  SELECT CASE
    WHEN r.hop = 0 AND r.from_agent_id IS NULL AND (r.purpose IS NULL OR r.purpose = '')
      AND r.orchestration_attempt_id IS NULL THEN 'person'
    ELSE 'handoff'
  END
  FROM message_runs r WHERE r.message_id = messages.id
)
WHERE author_kind = 'agent';
