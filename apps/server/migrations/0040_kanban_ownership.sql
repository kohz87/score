-- Qualified ownership for Kanban attempts (5.17a-1 stage 2a, design v5 §F). A task id belongs to a board lineage
-- (`kanban_histories.id`); every Score-side association of a task is stamped with the lineage it was made in. New
-- columns only and all nullable: with the attempts projection off nothing reads them, and a NULL means "unqualified"
-- (displayed, never routed, parked or released while attempts are on).

ALTER TABLE task_projections ADD COLUMN history_id TEXT;
ALTER TABLE brief_tasks ADD COLUMN history_id TEXT;
ALTER TABLE task_rooms ADD COLUMN history_id TEXT;
ALTER TABLE brief_edges ADD COLUMN history_id TEXT;
ALTER TABLE brief_paused_tasks ADD COLUMN history_id TEXT;
ALTER TABLE agent_paused_tasks ADD COLUMN history_id TEXT;
ALTER TABLE team_paused_tasks ADD COLUMN history_id TEXT;
ALTER TABLE approvals ADD COLUMN kanban_history_id TEXT;

-- Set once per history when the conservative upgrade of pre-existing rows has run (see ownership.ts).
ALTER TABLE kanban_histories ADD COLUMN ownership_qualified_at TEXT;

-- A denial is unique per (task, history, attempt, command): the same task id in another lineage is another denial.
DROP INDEX approvals_kanban_denial;
DROP INDEX approvals_kanban_denial_no_run;
CREATE UNIQUE INDEX approvals_kanban_denial ON approvals(
  kanban_task_id, COALESCE(kanban_history_id, ''), kanban_run_id, command_digest
) WHERE origin = 'kanban';
CREATE UNIQUE INDEX approvals_kanban_denial_no_run ON approvals(
  kanban_task_id, COALESCE(kanban_history_id, ''), command_digest
) WHERE origin = 'kanban' AND kanban_run_id IS NULL;
