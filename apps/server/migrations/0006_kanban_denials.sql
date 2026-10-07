CREATE UNIQUE INDEX approvals_kanban_denial ON approvals(kanban_task_id, kanban_run_id, command_digest) WHERE origin = 'kanban';
-- SQLite treats NULLs as distinct; missing worker run metadata must still dedupe.
CREATE UNIQUE INDEX approvals_kanban_denial_no_run ON approvals(kanban_task_id, command_digest) WHERE origin = 'kanban' AND kanban_run_id IS NULL;
