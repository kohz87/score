-- PLAN 11.11 (decision 118): pet packs, cut-out and ring looks are gone; an agent is its colour and shape. The columns
-- from 0078 (agent_styles / coding_agents: look, pack_rev, pack_meta) stay, unused from 11.11: dropping them, or letting
-- `look` be NULL, would mean rebuilding both tables around 0078's CHECK for no gain, so `look` keeps its 'cut' default
-- and nothing reads it. The pack references are cleared. The pack files under $SCORE_HOME/packs are removed by the
-- operator at deploy, never by code. Forward-only and idempotent.
UPDATE agent_styles SET pack_rev = NULL, pack_meta = NULL WHERE pack_rev IS NOT NULL OR pack_meta IS NOT NULL;
UPDATE coding_agents SET pack_rev = NULL, pack_meta = NULL WHERE pack_rev IS NOT NULL OR pack_meta IS NOT NULL;
