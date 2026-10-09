-- Observation intervals of Kanban attempts (5.17a-1 audit, fix batch F). An attempt can be observed, stop being
-- observed (source paused or unreadable, task deleted upstream) and be observed again; consumers need every
-- interval, not only the last boundary. Maintained by triggers so every writer of `observing` keeps it exact.
-- Times are ISO strings in the form Date#toISOString writes (ms precision, Z), so they compare as text.
CREATE TABLE kanban_attempt_observations (
  attempt_id TEXT NOT NULL REFERENCES kanban_attempts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (attempt_id, seq)
) STRICT;

-- Attempts recorded before this migration: the first interval runs from the attempt's start to its end or boundary;
-- a resumed open attempt gets a second, open one. Older gaps are not recoverable and are not invented.
INSERT INTO kanban_attempt_observations (attempt_id, seq, started_at, ended_at)
SELECT id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', started_at, 'unixepoch'),
       CASE WHEN ended_at IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', ended_at, 'unixepoch')
            ELSE observation_ended_at END
  FROM kanban_attempts;
INSERT INTO kanban_attempt_observations (attempt_id, seq, started_at, ended_at)
SELECT id, 1, observation_resumed_at, NULL
  FROM kanban_attempts
 WHERE ended_at IS NULL AND observing = 1 AND observation_ended_at IS NOT NULL
   AND observation_resumed_at IS NOT NULL;

CREATE TRIGGER kanban_attempt_observation_open AFTER INSERT ON kanban_attempts
BEGIN
  INSERT INTO kanban_attempt_observations (attempt_id, seq, started_at, ended_at)
  VALUES (NEW.id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at, 'unixepoch'),
          CASE WHEN NEW.ended_at IS NOT NULL
               THEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.ended_at, 'unixepoch') END);
END;

-- Observation stopped: at the end when the attempt closed while observed, else at the recorded boundary.
CREATE TRIGGER kanban_attempt_observation_close AFTER UPDATE ON kanban_attempts
WHEN OLD.observing = 1 AND NEW.observing = 0
BEGIN
  UPDATE kanban_attempt_observations
     SET ended_at = MAX(started_at, COALESCE(
           CASE WHEN NEW.ended_at IS NOT NULL
                THEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.ended_at, 'unixepoch') END,
           NEW.observation_ended_at, NEW.last_observed_at))
   WHERE attempt_id = NEW.id AND ended_at IS NULL;
END;

CREATE TRIGGER kanban_attempt_observation_resume AFTER UPDATE ON kanban_attempts
WHEN OLD.observing = 0 AND NEW.observing = 1 AND NEW.ended_at IS NULL
BEGIN
  INSERT INTO kanban_attempt_observations (attempt_id, seq, started_at, ended_at)
  SELECT NEW.id, COALESCE(MAX(seq), -1) + 1, COALESCE(NEW.observation_resumed_at, NEW.last_observed_at), NULL
    FROM kanban_attempt_observations WHERE attempt_id = NEW.id
   HAVING NOT EXISTS (SELECT 1 FROM kanban_attempt_observations WHERE attempt_id = NEW.id AND ended_at IS NULL);
END;
