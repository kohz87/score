-- PLAN 9.5: a theme package may carry licence files (`LICENSE`, `OFL.txt`) for the fonts and pictures it ships. They are
-- text, kept with the theme as a JSON object { "<file name>": "<text>" } and put back into its export.
ALTER TABLE themes ADD COLUMN licenses_json TEXT NOT NULL DEFAULT '{}';
