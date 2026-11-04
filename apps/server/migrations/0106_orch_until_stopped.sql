-- 3.27.0 (DECISIONS 162): a lead-decides run may keep going until the person stops it (no step or lead-turn cap);
-- such a run must carry a spend cap (budget_usd), checked by the server. max_steps / max_lead_turns stay at their
-- largest allowed values and only size the storage reserve.
ALTER TABLE orchestrations ADD COLUMN until_stopped INTEGER NOT NULL DEFAULT 0 CHECK (until_stopped IN (0, 1));
