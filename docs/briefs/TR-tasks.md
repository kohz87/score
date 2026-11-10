# TR — Tasks › Repeating and Tasks › Recipes (decision 183)

Owner, 2026-11-10: "mock up approved, ship together, keep assigned line". Approved mock-ups, **binding**:
`docs/design/bold/mockups/28-tasks-main.dc.html` (Tasks › Repeating), `28-tasks-edit.dc.html` (new / edit panel), `28-tasks-recipe.dc.html`
(Tasks › Recipes: the library and a recipe with a model per step that repeats), `28-tasks-assigned.dc.html` (direct chat Info and the agent page's
Work), `28-tasks-phone.dc.html`. Copy values from them, rebuild in React from the existing components, never paste their HTML; where a brief and a
mock-up differ, the mock-up wins and you report it.

The API is `docs/API-CONTRACT.md` §22 and `packages/contract/src/repeating.ts` (read both); the lead builds the server at the same time, so test the
web side with mocked responses (vitest), never against a server.

Split into three web tasks, each in its own worktree:
- **TR.2** Tasks › Repeating: the Tasks tabs, the list, the new/edit panel, phone.
- **TR.3** Tasks › Recipes: recipes move from Settings to Tasks, a model and effort per step, the Repeats card.
- **TR.4** Assignments: the agent page's Work keeps a read-only "Assigned" line; the direct chat's Info lists what's assigned.

## Rules for every task
Follow AGENTS.md: bold tokens under `[data-ui='bold']`, `bold-` class names, theme tokens only; anything that asks the person to decide (delete,
move, the missed-run note) carries `data-protected` and joins the protected list (`styles/protected.css` and its test); 44px targets on a phone; no
horizontal page scroll; `AgentGlyph` for agents. **Every file at or under 450 lines** (split by job); `docs/CODEMAP.md` for every file added, moved
or removed. **Never weaken or delete an existing test assertion**; tests that find something in its new place are updated, each listed. **Audit before
removing** (AGENTS.md): prove with a search that what you remove is unused. No new dependencies. Don't edit `docs/API-CONTRACT.md`,
`docs/ARCHITECTURE.md`, `apps/server`, `packages/contract`, `hermes-plugin`. Don't commit. Never run pkill or killall, never touch ports 8740 or
8741, never read `~/.hermes` or `~/.score`, never run real hermes, claude or codex, never use `SCORE_E2E_DEV=1` or `git stash`.

Checks: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`, and the vitest files you change or add. No full
run, no e2e (you may write or update e2e specs by reading; the lead runs them). Report: files changed, tests added or changed (with why), removals
with proof, every difference from the mock-ups, open questions.
