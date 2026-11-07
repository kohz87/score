# CS.2c — split `apps/server/src/hermes/fake/fake-port.ts` (brief)

PLAN "Code structure" CS.2 wave 1 (owner 2026-11-07, decision 168). `apps/server/src/hermes/fake/fake-port.ts` holds the fake Hermes adapter used in fake mode and e2e: its run, session, agent and screen fakes. It is over the 450-line
limit (AGENTS.md "File size and the code map"); split it into files of at most 450 lines, one job each.

## Do
1. Read the file and `docs/CODEMAP.md`. Plan the split (which parts go where) in a short comment block at the top of
   your report before moving code.
2. Split by responsibility into modules of one job each (for example: types and schemas, pure helpers, each subsystem), with the public exports kept where callers import them today (re-export from the original path if many callers use it, or update the imports). No logic, naming or behaviour changes; private functions may become module exports only where the split needs it.
3. Every new file stays at or under 450 lines; if the original file keeps some code, it too. Remove the original's
   entry from `scripts/size-exceptions.json` once it is at or under 450 (or delete the entry if the file is gone), and
   update `docs/CODEMAP.md` (the folder line and a line per new file).
4. Tests: change only import paths where needed; never an assertion. The existing tests are the proof the split moved
   code only.

## Rules
Follow AGENTS.md. A split moves code only: no fixes, renames of behaviour, or refactors in this change (note anything
you'd fix in the report). No new dependencies; don't edit docs/API-CONTRACT.md or docs/ARCHITECTURE.md; don't commit.
Never run pkill/killall, never touch ports 8740/8741, never read ~/.hermes or ~/.score, never git stash. No e2e runs
(the lead runs them at the release gate) — except for a CSS split: one temporary look-check spec on port 6402
comparing the affected screens before and after (production build, never `SCORE_E2E_DEV=1`), deleted afterwards.

## Done when
`pnpm check` passes (lint, format, typecheck, structure check, all tests) with `apps/server/src/hermes/fake/fake-port.ts` off the exception list.
Report: the new files and what each holds (with line counts), the check result, anything you noticed but didn't change.
