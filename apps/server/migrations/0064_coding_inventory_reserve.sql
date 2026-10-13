-- 7.7b-F1 #7: the coding items' share of a run's storage reserve is tracked on its own. `reserve_bytes` stays the run's
-- whole reserve (the quota is charged from it); `coding_reserve_bytes` is the part of it held for coding inventory
-- (results, retained inputs, run results), which ordinary text and observations can never spend. `coding_stored_bytes`
-- is what coding inventory has used of it (already counted in `stored_bytes`).
ALTER TABLE orchestrations ADD COLUMN coding_reserve_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orchestrations ADD COLUMN coding_stored_bytes INTEGER NOT NULL DEFAULT 0;
-- Runs that already have coding workers: the reserve they were created with held min(max_steps, coding_steps) items.
UPDATE orchestrations
   SET coding_reserve_bytes = MIN(max_steps, coding_steps) * 106496
 WHERE EXISTS (SELECT 1 FROM orc_worker_policies p WHERE p.orchestration_id = orchestrations.id);
