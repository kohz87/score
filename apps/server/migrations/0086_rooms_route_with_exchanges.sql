-- PLAN 11.11 (decision 118): older rooms and one-to-ones route with exchanges, so agents hand work on with the
-- exchange actions everywhere the person talks to them. Orchestration and workflow runs keep `mentions`: their
-- executor routes their rooms and never reads `routing`. Each room's default job keeps its old session keys.
UPDATE rooms SET routing = 'exchanges'
WHERE routing = 'mentions'
  AND role IN ('room', 'direct')
  AND id NOT IN (SELECT room_id FROM orchestrations);
