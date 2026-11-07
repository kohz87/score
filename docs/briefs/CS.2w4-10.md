# CS.2w4-10 — split 2 file(s) in `apps/server/src/domain/workflows` (brief)

PLAN "Code structure" CS.2 wave 4 (owner 2026-11-07, decisions 168–171). These files are over the 450-line limit
(AGENTS.md "File size and the code map"):

- `apps/server/src/domain/workflows/planner.ts` (909 lines)
- `apps/server/src/domain/workflows/views.ts` (830 lines)

## Do
0. **Audit first** (AGENTS.md "Audit before you split or clean up"): in these files, find what nothing uses (exports
   nothing imports — search the whole repo including tests, scripts, e2e and configs; private functions nothing calls;
   code for removed features). Remove only what is proven unused; list each item with its proof under "Removed as
   unused" in your report. Anything used only by tests, loaded dynamically or named in a config stays (list it under
   "Kept").
1. Split each file by responsibility into modules of one job each (types and schemas, pure helpers, each subsystem;
   for a React file, sub-components and hooks in their own files, the exported component stays in the original file;
   for CSS, area stylesheets `@import`ed from the original file in the original rule order, every selector and value
   kept exactly). Keep public exports where callers import them today (re-export from the original path).
2. No logic, naming or behaviour change beyond the audited removals.
3. Every resulting file is at or under 450 lines. Remove each original's entry from `scripts/size-exceptions.json`.
   Update `docs/CODEMAP.md`: one line per new non-test file, and the folder line if it changes.

## Checks you run
`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`. **No test runs, no e2e, no
`pnpm check`** (owner: no pre-fix checks; your sandbox can't run them either). Call tools only through the tool
interface, never as text.

## Rules
Follow AGENTS.md. No new dependencies; don't edit docs/API-CONTRACT.md or docs/ARCHITECTURE.md; don't commit. Never run
pkill/killall, never touch ports 8740/8741, never read ~/.hermes or ~/.score, never git stash.

## Report
"Removed as unused" (or "none") and "Kept"; per original file, the new files with line counts and what each holds
; the check results.
