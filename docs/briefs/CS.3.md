# CS.3 — Independent e2e specs (brief)

Owner, 2026-11-07 (decision 168, PLAN "Code structure"). These specs pass alone but fail in a full run, because they
depend on what other specs leave on the shared fake server (rooms, jobs, sessions, the team room's state, agents):

- `e2e/bold-room-menu.spec.ts` (8 tests: the room dropdown from the keyboard, Elsewhere → team job, a failed share
  retried, closing the panel mid-way)
- `e2e/bold-one-to-ones.spec.ts` (a shared reply in the team room; Escape / press outside / focus return)
- `e2e/bold-room-chat.spec.ts` (hover-row Copy / Edit / Try another; Edit rewinds; an agent that cannot be rewound)
- `e2e/bold-team-choice.spec.ts`, `e2e/bold-workspace.spec.ts` ("looks right"), `e2e/bold-tablet.spec.ts` ("layout uses
  the width"), `e2e/bold-plus-menu.spec.ts` (390, team room), `e2e/bold-take-over.spec.ts` ("a second browser…"),
  `e2e/bold-agent-faces.spec.ts`, `e2e/bold-recipes.spec.ts` ("leaving a dirty recipe…", fails on a reused server)

## Do
1. For each, find what shared state it depends on: run it after the specs that ran before it in a full run (the
   order in a full run is alphabetical per worker; reproduce with `--workers=1` and the preceding spec files), read
   the failure, and name the dependency in a one-line comment.
2. Make it independent: its own room (`makeRoom` in `e2e/bold-chat-helpers.ts`), its own job, its own agent session,
   its own fixed data (route mocks) — never cleaning up or resetting what other specs use (the server is shared and
   workers run in parallel). Where a spec reads the team room, give it its own team room if the behaviour allows.
3. Keep every assertion. If a test truly can't be independent, say why and propose a fix instead of weakening it.

## Rules
Follow AGENTS.md, including "File size and the code map" (any file you touch stays at or under 450 lines or splits;
the code map is updated if you add a file). Only `e2e/` changes; no app code (if the app has a real bug, stop and report
it). No new dependencies. Never run pkill/killall, never touch ports 8740/8741, never read ~/.hermes or ~/.score, never
use `SCORE_E2E_DEV=1`, never git stash, don't commit. Use port 6381 (`SCORE_WEB_PORT=6381 pnpm e2e …`), `--workers`
at most 2. Build once with `pnpm build` at the start.

## Done when
`SCORE_WEB_PORT=6381 pnpm e2e` (the full suite, workers as configured) passes twice in a row with none of these specs
failing, and `pnpm exec prettier --check e2e` and `pnpm lint` pass. Report: each spec's dependency and fix, the two
full-run results, anything left.
