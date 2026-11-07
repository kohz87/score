# CS.2l — split `apps/web/src/routes/chat/Composer.tsx` (brief)

PLAN "Code structure" CS.2 wave 2 (owner 2026-11-07, decision 168). `apps/web/src/routes/chat/Composer.tsx` is 1482 lines, over the 450-line
limit (AGENTS.md "File size and the code map"). Split it into files of at most 450 lines, one job each.

## Do
1. Read the file and `docs/CODEMAP.md`. Start your report with the planned split (which parts go where).
2. Split by responsibility into modules of one job each (types and schemas, pure helpers, each subsystem or each sub-component). Keep the public exports where callers import them today (re-export from the original path). For a React component file: move sub-components and hooks into their own files; keep the exported component in the original file. No logic, naming or behaviour changes; private functions may become module exports only where the split needs it.
3. Every new file is at or under 450 lines, and so is what stays in the original. Remove the original's entry from
   `scripts/size-exceptions.json`. Update `docs/CODEMAP.md` with one line per new file saying what it holds.
4. Tests: change only import paths where needed, never an assertion.

## Checks you run (your sandbox cannot open ports, and full test runs hang there)
`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`, and `pnpm --filter @score/web test`. Do not run
`pnpm check`, `pnpm test` for the whole repo, or e2e: the lead runs those. Call tools only through the tool interface.

## Rules
Follow AGENTS.md. A split moves code only: no fixes or refactors (note anything you'd change in the report). No new
dependencies; don't edit docs/API-CONTRACT.md or docs/ARCHITECTURE.md; don't commit. Never run pkill/killall, never
touch ports 8740/8741, never read ~/.hermes or ~/.score, never git stash.

## Done when
The checks above pass with `apps/web/src/routes/chat/Composer.tsx` off the exception list. Report: the new files with line counts and what each holds,
the check results, anything you noticed but didn't change.
