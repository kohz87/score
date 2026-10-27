-- 3.8.0 (decision 142): a recipe with runs is archived instead of deleted; archived recipes are hidden and not offered.
ALTER TABLE workflow_definitions ADD COLUMN archived_at TEXT;
