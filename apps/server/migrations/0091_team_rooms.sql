-- 3.4.0 (decision 136): more than one team room. The first one keeps every agent (team_everyone = 1, at most one);
-- the others hold the agents the person chose.
ALTER TABLE rooms ADD COLUMN team_everyone INTEGER NOT NULL DEFAULT 0 CHECK (team_everyone IN (0, 1));
UPDATE rooms SET team_everyone = 1 WHERE role = 'team';
DROP INDEX rooms_team;
CREATE UNIQUE INDEX rooms_team_everyone ON rooms (team_everyone) WHERE team_everyone = 1;
