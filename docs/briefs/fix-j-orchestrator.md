# Fix batch J: recovered-result repair must invalidate unsent consumers (2026-10-10)

Source: `docs/reviews/2026-10-10-7.1-workflow-builder-v8.2-codex.md`, high "Recovery leaves an unsent consumer authorized
to dispatch withdrawn evidence". Code: `repairRecoveredResults` (fix-i 2) in apps/server/src/domain/orchestration/.
Follow AGENTS.md; no new dependencies; no migration unless unavoidable (then 0050 — tell the lead; 6.6 may also need
0050, so prefer none).

1. The repair retires every **provably unsent** consuming attempt (state `created`, no `send_started` in DB or journal for
   its latest generation) of a step whose dependency's result was withdrawn: the attempt is refused/retired with
   disposition `input_withdrawn`, its approved gate is withdrawn, and its frozen input is invalidated; the step goes
   `blocked` and the lead gets a `step_blocked` cause. Possibly-sent consumers are recorded separately in the
   `recovered_result_withdrawn` history entry (unchanged obligations).
2. `beginSend` verifies **result eligibility** of everything the attempt's input consumed (each consumed step's current
   result revision equals the one frozen in the input, and it is not recovered-text-only); a mismatch refuses the send
   the same way. (7.1 will apply the same check through `wf_consumed`.)
3. Tests (failing first): upgrade → repair → Abandon → Resume with an actual `created` consumer attempt (never sends);
   a consumer whose dependency result revision changed after claim (never sends); an already-sent consumer is only
   recorded.

Done when: lint, format:check, typecheck, contract/server/web suites, the two orchestration e2e specs green.
