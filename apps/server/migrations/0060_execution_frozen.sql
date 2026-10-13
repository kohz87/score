-- 7.7a fifth fix round FV (decision 71): why Score holds all agent work (a copied home, a lost or truncated execution
-- journal). Set by the startup check, cleared only by `scripts/score installation reset-history`.
ALTER TABLE orc_global ADD COLUMN frozen_reason TEXT;
