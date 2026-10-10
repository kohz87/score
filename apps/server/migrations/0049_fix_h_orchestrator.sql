-- Fix batch H (7.1 v7 review). Orchestrator safety.
-- 1. Where a terminal run status came from: 'runtime' (Hermes said so) or 'recovered' (rebuilt from session-history
--    text after Hermes forgot the run). NULL is a legacy runtime row. Recovered text is shown, never termination evidence.
ALTER TABLE runs ADD COLUMN terminal_source TEXT CHECK (terminal_source IN ('runtime', 'recovered'));
