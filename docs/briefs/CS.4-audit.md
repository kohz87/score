# CS.4 audit — what in the tests no longer earns its place (brief)

Decision 170. Read-only: change nothing, delete nothing. Produce a candidate list the lead approves item by item.

## Find, with proof for each
1. **Screenshot baselines no spec uses** (`e2e/*.spec.ts-snapshots/*.png`). Playwright names a baseline from the
   `toHaveScreenshot('<name>.png')` argument, or from the test title plus a counter when there's no argument. Proof:
   the spec and the name it would produce; no test in that spec produces this file.
2. **Fixtures nothing loads** (`apps/server/test/fixtures/**`, `hermes-plugin/tests/fixtures/**`, any `__fixtures__`).
   Proof: no reference by file name, by folder glob or by a computed path (read the loaders, e.g. any `readdirSync`
   over a fixtures folder). If a folder is loaded whole, its files are used.
3. **Helpers and test utilities nothing imports** (`e2e/*.ts` that aren't specs, `test/**/helpers*`, `*-test-utils*`).
   Proof: no import, and not named in a config (`playwright.config.*`, `vitest.config.*`, `globalSetup`, `globalTeardown`).
4. **Skipped tests** (`.skip`, `.todo`, `test.fixme`, `describe.skip`, `it.skipIf`). For each: why it's skipped (the
   comment, `git log -S` on the line), and whether the behaviour still exists. Say "fix" or "delete", with the reason.
5. **Tests of removed features**: the step diagram, OrchestrationLive, BoldRuns and the old run pages, room-project
   PATCH/DELETE, and anything else whose subject no longer exists in `apps/*/src`. Proof: the subject is gone (`git log`
   for the commit that removed it) and the test only exercises the leftover. A test that merely mentions an API path
   that still exists is not a candidate.
6. **Duplicate coverage**: two tests asserting the same behaviour at the same level (two unit tests of the same
   function and case, or two e2e tests driving the same flow and checking the same thing). Name the test that keeps
   the coverage. Different levels (unit vs route vs e2e) are not duplicates unless the e2e checks nothing the lower
   ones don't; be conservative here.

## Rules
Read-only. Never run e2e or start servers. Never read ~/.hermes or ~/.score. Never run pkill/killall. Don't commit.

## Report
A table per category: path (and test name), the proof (a command and its result, or file:line), and your
recommendation (delete / fix / keep). Totals at the top. Anything uncertain goes under "keep", with a note.
