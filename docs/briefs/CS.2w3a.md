# CS.2w3a — split the test file `packages/contract/test/schemas.test.ts` (brief)

PLAN "Code structure" CS.2 wave 3 (owner 2026-11-07, decisions 168–171). `packages/contract/test/schemas.test.ts` is 2824 lines, over the 450-line
limit (AGENTS.md "File size and the code map"). Split it by feature into test files of at most 450 lines each.

## Do
0. **Audit first** (AGENTS.md "Audit before you split or clean up"). In this file, find helpers, fixtures and setup
   code nothing uses. Remove only what is proven unused, and list each item with its proof under "Removed as unused" in
   your report. **Never remove a test case or an assertion**: the test cleanup (CS.4) already decided which tests stay.
1. Group the tests by the feature they cover, one new file per group, named `<original stem>-<feature>.test.<ext>`
   next to the original (or replace the original entirely). Shared setup (`beforeEach`, factories, helpers) used by
   several groups goes into one helper module beside them (e.g. `<stem>-helpers.ts`, not a test file), imported by each.
2. Every test keeps its exact title, body and assertions; only its file changes. `describe` blocks that grouped them
   keep their titles (repeat the describe in each new file when its tests are spread over several).
3. Every new file is at or under 450 lines. Remove the original's entry from `scripts/size-exceptions.json` (delete the
   file if nothing is left in it). Update `docs/CODEMAP.md` (the test folder's line; one line per helper module).

## Checks you run
`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`. **No test runs, no e2e** (owner:
"don't do pre-fix check, only post-fix check"; your sandbox also can't run them). Call tools only through the tool
interface.

## Rules
Follow AGENTS.md. Apart from the audited removals, a split moves code only: no new tests, no fixes, no renamed tests. No
new dependencies; don't commit. Never run pkill/killall, never touch ports 8740/8741, never read ~/.hermes or ~/.score,
never git stash.

## Done when
The checks above pass with `packages/contract/test/schemas.test.ts` off the exception list. Report: "Removed as unused" (or "none"), the new files with
line counts and the tests each holds (count), the check results.
