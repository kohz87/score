# CS.2h — split `apps/web/src/routes/chat/chat.css` (brief)

PLAN "Code structure" CS.2 wave 1 (owner 2026-11-07, decision 168). `apps/web/src/routes/chat/chat.css` holds the chat (composer, messages, menus) styles. It is over the 450-line
limit (AGENTS.md "File size and the code map"); split it into files of at most 450 lines, one job each.

## Do
1. Read the file and `docs/CODEMAP.md`. Plan the split (which parts go where) in a short comment block at the top of
   your report before moving code.
2. Split by area of the screen (one stylesheet per component or section), each imported where that component is (or from the same entry the current file is imported from, in the same cascade order). Keep every selector, value and media query exactly; the order of rules that override each other must not change.
3. Every new file stays at or under 450 lines; if the original file keeps some code, it too. Remove the original's
   entry from `scripts/size-exceptions.json` once it is at or under 450 (or delete the entry if the file is gone), and
   update `docs/CODEMAP.md` (the folder line and a line per new file).
4. Tests: change only import paths where needed; never an assertion. The existing tests are the proof the split moved
   code only.

## Rules
Follow AGENTS.md. A split moves code only: no fixes, renames of behaviour, or refactors in this change (note anything
you'd fix in the report). No new dependencies; don't edit docs/API-CONTRACT.md or docs/ARCHITECTURE.md; don't commit.
Never run pkill/killall, never touch ports 8740/8741, never read ~/.hermes or ~/.score, never git stash. No e2e runs
(the lead runs them at the release gate) — except for a CSS split: one temporary look-check spec on port 6407
comparing the affected screens before and after (production build, never `SCORE_E2E_DEV=1`), deleted afterwards.

## Done when
`pnpm check` passes (lint, format, typecheck, structure check, all tests) with `apps/web/src/routes/chat/chat.css` off the exception list.
Report: the new files and what each holds (with line counts), the check result, anything you noticed but didn't change.
