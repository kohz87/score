# Fix batch K: flaky tests (2026-10-10)

Each fails the same way on main; fix the tests (or real races they expose), never by adding retries or sleeps.
1. `e2e/chat.spec.ts` "fake Chat opens rooms and directs…" fails when run after specs that post into the shared fake
   `#activity-feed` room (chat-rewind, chat-actions, chat-documents, knowledge-files): it looks for the oldest seeded
   message, which falls out of the 50-message page. Make it independent of order (own room or assert on what it creates).
   Same pattern in `chat-documents.spec.ts` — fix it too.
2. `e2e/chat-formatting.spec.ts`: code-block Copy ("Copied" never appears) and Stop (`toBeVisible` timeout) fail ~2 of 6
   runs alone (`--repeat-each=6`). Find the race (clipboard permission/focus, stream timing) and fix it in the test or app.
3. `apps/server/test/runtimes/coding-runtime.test.ts` (incl. "Reports: Claude Code spend") fails under the full parallel
   server run, passes alone: find the shared state / timing assumption and fix it.
4. After a rebuild, the first `visual.spec.ts` run sometimes fails "element(s) not found" and a rerun passes: find the
   cause (fixtures/fonts/server warm-up) and fix it.

Done when: each spec passes `--repeat-each=6` alone and in the full `pnpm e2e` run twice in a row; the full server suite
passes twice in a row with default workers; `pnpm check` green.
