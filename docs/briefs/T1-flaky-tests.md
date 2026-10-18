# T1 Fix the load-flaky tests (lead, 2026-10-18; owner chose "lighter testing", which includes fixing flaky tests)

These failed repeatedly under load on the old VM and passed alone. Fix each at its cause (fake clocks, deterministic
waits on the real condition, no wall-clock thresholds that depend on machine speed). Never weaken what a test proves:
if a test checks a real time limit (S2-005), make the limit observable without depending on scheduler timing (e.g. a
fake clock or an injected limit of a few hundred ms with a generous assertion window that still fails without the code).

Known list (from docs/TASKLOG.md and recent runs):
1. `apps/server/test/runtimes/coding-process.test.ts` › S2-005 wall-clock limit (worker stdio inherit / outlives leader).
2. `apps/server/test/knowledge/audit2-t.test.ts` › S2-021 linear scaling ("indented code: 4x the input costs about 4x").
3. `apps/server/test/hermes/live-port.test.ts` › "starts idempotently, follows to completion and forwards stop" and
   "gate #11 supervisor restarts a follower".
4. `apps/server/test/runtimes/coding-runtime.test.ts` › S2-006, "the intent is durable before anything spawns", "an
   untested CLI version runs only after the person confirms that version", "Add agent lists the CLIs…".
5. `apps/server/test/knowledge/*` › "1,000 entries is fine".
6. e2e: `live-feel.spec.ts` "a running reply shows its status line…", `user-view.spec.ts` "an orchestration from chat:
   status lines arrive…" and "Pause, Resume and Stop from the chat", `now.spec.ts` "matches the design with fixed data"
   (1px height jitter), `conversations.spec.ts` "pin, archive, project and tags…".
7. `user-view.spec.ts` password guard: its wrong guesses count toward the server-wide attempt limit, so repeats fail —
   give it its own paired browser/limit scope or reset the counter in the fake server between tests (test-only hook).
8. The shared e2e server: specs that add agents must remove them in `finally` (see `long-description.spec.ts`); add a
   guard that fails a spec which leaves agents behind.

Method: reproduce each under load (run the file with `--repeat-each` and parallel CPU load, e.g. two other vitest runs)
before and after the fix; report the before/after pass rates. Done when every item has a fix that passes 20/20 under
load, `pnpm check` and full `pnpm e2e` green.
