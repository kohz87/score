# CS.2w5-14 — split the test file `hermes-plugin/tests/test_review_regressions.py` (brief)

PLAN "Code structure" CS.2, the last files (decision 172). This pytest file is 611 lines, over the 450-line limit
(AGENTS.md "File size and the code map"). Split it by feature into test files of at most 450 lines each.

## Do
0. **Audit first** (AGENTS.md "Audit before you split or clean up"): find helpers and fixtures in this file that nothing
   uses; remove only what is proven unused, each with its proof under "Removed as unused". **Never remove a test or an
   assertion.**
1. Group the tests by the feature they cover into `hermes-plugin/tests/test_review_regressions_<feature>.py` files.
   Shared fixtures and helpers used by several new files go into `hermes-plugin/tests/conftest.py` (if it exists, add
   to it without changing what is there) or a helper module the files import. Every test keeps its exact name, body,
   decorators (including `skipif`) and assertions.
2. Every file stays at or under 450 lines. Remove the original's entry from `scripts/size-exceptions.json` (delete the
   original if nothing is left). Update `docs/CODEMAP.md` if it names the file.

## Checks you run
`python3 -m py_compile` on every changed or new file, and `node scripts/structure-check.mjs`. **No test runs** (owner: no
pre-fix checks). Call tools only through the tool interface, never as text.

## Rules
Follow AGENTS.md. Never read ~/.hermes or ~/.score; never run pkill/killall; never touch ports 8740/8741; never git
stash; don't commit; no new dependencies.

## Report
"Removed as unused" (or "none"); the new files with line counts and how many tests each holds; the check results.
