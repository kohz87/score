# PAUSED: Codex out of credits (2026-10-07, second time)

**Status: all work paused, per the owner's rule** (CLAUDE.md, "If Codex runs out of quota"). Nothing further gets
reviewed, merged or coded, by Codex or by Claude, until the owner gives an explicit go.

## What stopped it
The 1.13b implementation run (Codex CLI, `gpt-6.1-sol`, `high`, session `01a11579-cdab-7fb3-8fb7-8b57ff67155e`) ended
after ~106k tokens with `ERROR: Your workspace is out of credits. Add credits to continue.` `scripts/codex-task.sh`
detected it (exit 75). Codex wrote **no final report** (`~/.score/codex/runs/1.13b/round-0.md` doesn't exist); the full
log is `~/.score/codex/runs/1.13b/round-0.log`.

## State of `main`
Merged and green (contract 339, web 200, server 792, plugin 133, e2e 13, license 209): Phase 0 and tasks 1.1–1.11b,
1.13a (bridge plugin), 1.14a (bridge server) and 1.14b (approvals ledger). Details per task: `docs/TASKLOG.md`.

## In flight: task 1.13b (gateway approvals, plugin side), NOT merged, work **incomplete**
- Brief: `docs/briefs/1.13b.md` (committed). Worktree `../score-worktrees/1.13b-gateway-approvals`, branch
  `task/1.13b-gateway-approvals`, all changes **uncommitted**: 10 tracked files changed (+147/−17) and new files
  `hermes-plugin/score_bridge/{approvals,decisions,decision_transport}.py`,
  `hermes-plugin/tests/{test_gateway_approvals.py,server-approvals-check.py}`,
  `apps/server/test/hermes/bridge/plugin-approvals.test.ts`.
- The run was cut off mid-edit, so treat the worktree as **half-written**. Already visible in the last diff: in
  `sender.py` shutdown, `client._poller.join(deadline)` passes an absolute monotonic deadline as a timeout (should be
  `max(0, deadline - time.monotonic())`).
- Brief item 4 (server: `enabled.gatewayApprovals` no longer requires `register_gateway_settle`) shows no change in
  `apps/server/src/hermes/bridge/routes.ts`; verify on resume whether main already satisfies it.
- Nothing from 1.13b has been reviewed or tested by the lead.

## Not started
1.13c (Kanban one-shot grants + live test L6), then the Phase 1 gate (Codex `max` review + the owner's Gemini review).

## Resume checklist (after the owner says go)
1. Vet the 1.13b worktree: `git -C ../score-worktrees/1.13b-gateway-approvals status`, read the whole diff, look for
   half-written functions, run `uv run --offline pytest -q` in `hermes-plugin/` and `pnpm check`.
2. Decide: finish it with a fresh Codex fix round (brief + "the previous run was cut off; complete it" + the defects
   found in step 1), or take it over if the remainder is small.
3. Lead review, live check on scoretesta (a run started directly against Hermes, approval answered through Score),
   code review at `high`, merge. Then 1.13c.
