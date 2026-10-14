-- 7.7c #8 (design §4 W4): a coding node whose dispatch was held back 20 times can be renewed by the person (a fresh attempt
-- on the same step, the reservation transferred). Renewals are counted per node and bounded; they never spend the node's
-- execution retries (`attempts_max`).
ALTER TABLE wf_nodes ADD COLUMN renewals INTEGER NOT NULL DEFAULT 0;
