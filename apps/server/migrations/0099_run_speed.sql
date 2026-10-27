-- 3.10.0 (decision 148): speed figures. When Score first saw a run produce reply text (a coding CLI's own ttft_ms is
-- folded in as started_at + ttft), and the figures of the run behind a finished agent reply, as JSON.
ALTER TABLE runs ADD COLUMN first_output_at TEXT;
ALTER TABLE messages ADD COLUMN speed TEXT;
CREATE INDEX runs_started_at ON runs(started_at);
