# Fix batch I: executor defects confirmed by Codex's 7.1 v8.1 review (2026-10-10)

Source: `docs/reviews/2026-10-10-7.1-workflow-builder-v8.1-codex.md` (three highs, each confirmed by an in-memory probe;
read their **Where/What happens/Change**). Live orchestrator code: apps/server/src/domain/orchestration/. No migration
unless one is unavoidable (then 0050; tell the lead). Follow AGENTS.md; no new dependencies; don't commit to main.

1. **Send barrier order.** In `beginSend`, reconcile first (fresh run facts), **then** recompute run status, every
   independent hold (manual, budget/unknown-spend/deadline conditions, agent/team pause, fence, unknown and cancel
   fences, frozen mapping) immediately before journaling `send_started`. Test: a recovered or interrupted sibling
   arriving between two dispatches → the second is not sent.
2. **Recovered success is never consumable.** Separate historical text from result eligibility: an attempt that is or
   was `recovered_text_only` can't make its step `succeeded`. Upgrade path (0049 already ran on the live DB, which had
   no affected rows): a startup repair (idempotent, journaled) downgrades such steps (and finished runs whose outcome
   relied on them) to `unknown`/`finished_with_unresolved`, withdraws approvals of dependents that consumed them, and
   records affected consumers. Abandon never restores synthetic success. Tests: upgrade → Abandon → Resume (dependent
   not admitted with that result), a previously finished run, an already-created consumer.
3. **Remap clears only its own condition.** Remap removes the `agent_unavailable` condition only; admissibility is
   derived from all holds, and claim and send check `manual_paused_at` directly. Test: replacement pause → manual Pause
   → remap (stays paused; no new lead attempt; queued steps not admitted), plus restore after it.

Done when: failing test first for each (confirm it fails on main), then fix; lint, format:check, typecheck,
contract/server/web suites, the two orchestration e2e specs green. Report per item.
