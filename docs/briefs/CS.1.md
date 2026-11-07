# CS.1 — Code maps and the 450-line limit (brief)

Owner, 2026-11-07 (decision 168): every source file does one job and stays at or under 450 lines; every package has a
code map so agents and people find code without reading the tree. Read AGENTS.md "File size and the code map" first.

## Build
1. **`docs/CODEMAP.md`**: sections for `apps/web/src`, `apps/server/src` (+ `migrations/`, `scripts/`),
   `packages/contract/src`, `hermes-plugin/score_bridge`, `scripts/`, `e2e/`. One line per folder (what it owns), and
   one line per key file (entry points, the files most tasks touch: e.g. `app.ts`, `http/rooms.ts`, the executor, the
   bold shell, the room, the stream client). Plain, short, written for someone looking for "where is X"; no code.
   Keep each section's lines in folder order. Add an index at the top ("I want to change … → look in …", ~20 lines).
2. **The limit in ESLint**: `max-lines` at 450 (`skipBlankLines: false`, `skipComments: false`) for `*.ts`, `*.tsx`,
   `*.mjs` in `apps/`, `packages/`, `scripts/`, `e2e/`. Files over the limit today go in `scripts/size-exceptions.json`
   (`{ "path": "...", "lines": N, "reason": "split in CS.2 wave 1" | "generated" | "data list" }`), and ESLint skips
   only those (an override built from the file).
3. **`scripts/structure-check.mjs`**, run by `pnpm check` (add it to the check script): fails when (a) a CSS or Python
   source file (`apps/**/src/**/*.css`, `hermes-plugin/score_bridge/**/*.py`) is over 450 lines and not on the list;
   (b) a file on the list is now at or under 450 lines (it must leave the list); (c) a file on the list grew past its
   recorded `lines` (the list never lets a big file grow); (d) a source folder (any folder under the sections above
   that holds a source file) is not named in `docs/CODEMAP.md`. Clear messages naming the file and the fix.
4. **Tests** for the check script (vitest, a temp tree): each failure case and a clean tree.

## Constraints
Follow AGENTS.md, including the new section (this task's own files stay under 450 lines). No new dependencies; don't
edit docs/API-CONTRACT.md, docs/ARCHITECTURE.md or application code (only config, scripts, docs, tests). Don't commit.
Never run pkill/killall, never touch ports 8740/8741, never read ~/.hermes or ~/.score, never git stash. Run
`pnpm check` before finishing; it must pass with today's code (every big file on the exception list).

## Report
Files changed, the exception list's size (files, lines), the check's output on a deliberately bad tree, `pnpm check`
result, open questions.
