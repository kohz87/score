# CS.2w5-12 — split `hermes-plugin/score_bridge/spool.py` (brief)

PLAN "Code structure" CS.2, the last files (decision 172). `hermes-plugin/score_bridge/spool.py` is 508 lines, over the 450-line limit
(AGENTS.md "File size and the code map"). Split it into modules of at most 450 lines, one job each.

This file is inside the Python boundary (`hermes-plugin/score_bridge/`). New modules stay in that package. Every call into private Hermes functions stays in `score_bridge/hermes_private.py` (AGENTS.md): never move or copy such a call into a new module.

## Do
0. **Audit first** (AGENTS.md "Audit before you split or clean up"): find what in this file nothing uses (search the
   whole repo, including tests, scripts, e2e, the plugin and configs). Remove only what is proven unused, each item with
   its proof under "Removed as unused" in your report; when in doubt, keep it and list it under "Kept".
1. Split by responsibility (types and constants, pure helpers, each subsystem). Function bodies move unchanged; private
   helpers may become module exports only where the split needs it. Keep the module's public names importable from the original module (re-export them).
2. Every resulting file is at or under 450 lines. Remove the original's entry from `scripts/size-exceptions.json`.
   Update `docs/CODEMAP.md` (one line per new file; the folder line if it changes).

## Checks you run
`python3 -m py_compile` on every changed or new .py file, and `node scripts/structure-check.mjs`. **No test runs** (owner: no pre-fix checks; your sandbox can't run them). Call tools only through the tool
interface, never as text.

## Rules
Follow AGENTS.md. No behaviour, naming or API change beyond the audited removals. No new dependencies; don't edit
docs/API-CONTRACT.md or docs/ARCHITECTURE.md; don't commit. Never run pkill/killall, never touch ports 8740/8741, never
read ~/.hermes or ~/.score, never git stash.

## Report
"Removed as unused" (or "none") and "Kept"; the new files with line counts and what each holds; the check results.
