-- 7.7c F1 #6: a coding run's partition also holds the retained inputs of coding attempts that were prepared and not sent
-- (blocked for a decision, or queued), bounded at min(max_steps, 2 x max_concurrent_steps) inputs of 32 KiB, independent of
-- the coding step limit. Runs that already have coding workers get that room added to their reserve and their partition.
UPDATE orchestrations
   SET reserve_bytes = reserve_bytes + MIN(max_steps, 2 * max_concurrent_steps) * 32768,
       coding_reserve_bytes = coding_reserve_bytes + MIN(max_steps, 2 * max_concurrent_steps) * 32768
 WHERE EXISTS (SELECT 1 FROM orc_worker_policies p WHERE p.orchestration_id = orchestrations.id);
