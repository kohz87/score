# CS.2w4-77 — split 1 file(s) in `e2e` (brief)

PLAN "Code structure" CS.2 wave 4 (owner 2026-11-07, decisions 168–171). These files are over the 450-line limit
(AGENTS.md "File size and the code map"):

- `e2e/workflow-fixtures.ts` (822 lines)

## Do
0. **Audit first** (AGENTS.md "Audit before you split or clean up"): in these files, find what nothing uses (exports
   nothing imports — search the whole repo including tests, scripts, e2e and configs; private functions nothing calls;
   code for removed features). Remove only what is proven unused; list each item with its proof under "Removed as
   unused" in your report. Anything used only by tests, loaded dynamically or named in a config stays (list it under
   "Kept").
1. Split each test file by the feature its tests cover, into test files of at most 450 lines named
   `<original stem>-<feature>.<test|spec>.<ext>` beside it. Shared setup (`beforeEach`, factories, helpers) used by
   several new files goes into one helper module beside them (not a test file), imported by each.
2. Every test keeps its exact title, body and assertions; `describe` titles are kept (repeated where a describe's tests
   are spread over files). Keep each `beforeEach`/`afterEach` and `vi.mock` applying to exactly the tests it applied
   to before.
**Never remove a test case or an assertion**; "Removed as unused" may only list unused helpers.
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
(and how many tests); the check results.
