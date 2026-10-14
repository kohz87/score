# Follow-ups after 7.7 (v1.3.0)

One builder, branch `task/followups-7.7` (worktree `../score-worktrees/followups`), in order, failing-first tests.

## 1. A waiting reason for parked coding steps
A coding step that admission parks because the run's room for unsent coding inputs is used up (`executor.ts` ~2223:
`codingUnsentSlots` or `coding_reserve_bytes`) stays `queued` with no reason. Add the waiting reason `coding_room`:
- contract: `docs/API-CONTRACT.md` first, then `WaitingForSchema` (workflows) and the orchestration step view's waiting
  field if it has one (check; add the same value there if steps show a waiting reason);
- server: computed in the views (never stored as a status): a queued coding step that admission would park for room;
- web: plain text in both views per docs/WRITING.md, e.g. "Waits for room: other coding steps of this run hold their
  inputs until they are sent or finished." No new action.
Tests: the 24-node fan-out probe from `coding-f1-inventory.test.ts` shows `coding_room` on the parked steps and not on
admitted ones; a web test renders the text.

## 2. Make four load-flaky tests deterministic
Each fails only under full-suite load and passes alone: find the timing dependency and remove it (fake timers, awaiting
the real signal, or a deterministic ordering), never just a longer timeout or a retry:
- `apps/server/test/http/media.test.ts` "deleting a message releases its media references; a rewind keeps them…"
  (saw `[2, 2]` instead of `[1, 1]`);
- `apps/web/src/routes/team/knowledge-tools.test.tsx` "the switch is hidden when the server has no knowledge vault";
- `apps/web/src/routes/knowledge/editor-toolbar.test.tsx` "lists, quote and undo / redo";
- `apps/server/test/runtimes/coding-runtime.test.ts` "a real server crash leaves the CLI child running…" (uses a real
  child process; make its waits signal-based).
For each, explain the cause in the commit message. If one is a real product race, say so and fix the product.

Then `pnpm check` twice in a row (both green), the full e2e (SCORE_WEB_PORT=5491).
