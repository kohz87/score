**10 fixed; 3 partly fixed**, accounting for both accepted deviations.

1. **Fixed** — Assignment/header/AWS-key probes now redact correctly, including gateway payloads: [redact.ts:29](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/redact.ts:29).
2. **Partly** — New hellos require shipped plugin version, normalized Hermes version, exact SHA and private APIs; existing producer grants survive upgrade: [routes.ts:91](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/hermes/bridge/routes.ts:91).
3. **Fixed** — No completion attribution without exact gate IDs; accepted deviation leaves bridge approvals at `decided`: [approvals.ts:600](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/domain/approvals.ts:600).
4. **Fixed** — Uncertain admission replay stops after 23 hours; legacy timestamps are conservatively backfilled: [intents.ts:61](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/hermes/live/intents.ts:61).
5. **Fixed** — Drain probe delivered counters 2, 3 and trailing gap 4; contiguous acknowledgement reached 4 and emptied the spool: [sender.py:270](/home/raven/score-worktrees/1.gate-gate-fixes/hermes-plugin/score_bridge/sender.py:270).
6. **Fixed** — Hello establishes the initial cursor; reset/epoch changes rebase it; valid replay preserves it: [stream.ts:92](/home/raven/score-worktrees/1.gate-gate-fixes/apps/web/src/data/stream.ts:92).
7. **Fixed** — Identifier probes preserve session IDs; plugin lifts identifiers before scrubbing: [sender.py:189](/home/raven/score-worktrees/1.gate-gate-fixes/hermes-plugin/score_bridge/sender.py:189).
8. **Partly** — Deadline enforcement is atomic, but shutdown cancellation is absent inside the resolver: [hermes_private.py:74](/home/raven/score-worktrees/1.gate-gate-fixes/hermes-plugin/score_bridge/hermes_private.py:74).
9. **Fixed** — Restored acknowledgement uses the larger checkpoint/floor; an in-memory probe confirmed this: [registry.ts:18](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/hermes/bridge/registry.ts:18).
10. **Fixed** — Unblock captures old card IDs before awaiting Hermes and closes only those: [tasks.ts:38](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/http/tasks.ts:38).
11. **Fixed** — One supervisor promise per run retries with the specified backoff; stop aborts followers and waits: [live-port.ts:263](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/hermes/live/live-port.ts:263).
12. **Partly** — Concurrent probe executed one action and replayed identical responses; crash-pending receipts are later forgotten: [idempotency.ts:43](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/http/idempotency.ts:43).
13. **Fixed** — Empty sweeps read before submitting; internal UUID-source keys retire after 24 hours: [retire.ts:52](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/hub/retire.ts:52).

The remaining upgrade defect under finding 2 is **High**: [0007_gate_fixes.sql:1](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/migrations/0007_gate_fixes.sql:1) leaves existing `gateway_approvals=1` flags untouched. A six-migration database containing an untested producer remained actionable after applying 0007. Existing credentials therefore bypass the new qualification until re-hello. **Minimal fix:** revoke persisted grants during migration/startup and require qualified re-hello before accepting or delivering decisions.

Two new defects meet the review bar:

- **High — Retention permits repeating an uncertain action.** [idempotency.ts:45](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/http/idempotency.ts:45), [retire.ts:57](/home/raven/score-worktrees/1.gate-gate-fixes/apps/server/src/hub/retire.ts:57). Crash after a CLI comment succeeds but before receipt completion leaves a pending row. Both cleanup paths delete it after 24 hours; the same retry then executes again. Probe: `200 → crash-pending 409 → expiry → 200`, two action calls. **Minimal fix:** expire completed receipts only; retain unresolved tombstones until reconciled or explicitly resolved.

- **Medium — Approval can resolve after poller shutdown without acknowledgement.** [decisions.py:64](/home/raven/score-worktrees/1.gate-gate-fixes/hermes-plugin/score_bridge/decisions.py:64), [hermes_private.py:77](/home/raven/score-worktrees/1.gate-gate-fixes/hermes-plugin/score_bridge/hermes_private.py:77). The resolver waits for the remaining lease, potentially 30 seconds, without observing stop. A contention probe called `stop()`, released the lock, and observed `result='always'`; acknowledgement is suppressed by the stopped poller. **Minimal fix:** use short bounded acquisition attempts and recheck cancellation inside the critical section before committing.

No additional gate-level defect surfaced in follower duplication, drain resending/memory, or Hermes choice handling. Migration 0007 successfully upgraded schemas 1–6.

Typecheck, lint and formatting passed. **60 targeted Python tests passed**; two filesystem-dependent tests and the JavaScript suites were blocked by the read-only sandbox. No files changed.

**Gate verdict: fail.**