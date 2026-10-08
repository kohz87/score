# Draft proposal (not sent): stop one Kanban attempt safely

**Status:** draft by Score's lead for the owner (task 5.17b). Nothing has been posted to NousResearch. The owner decides
whether and where to propose it (issue or PR on `NousResearch/hermes-agent`). Facts are from Hermes `e97923c`, verified
by Score's design review (`docs/reviews/2026-10-08-5.17-design-codex.md`).

## Problem
An operator watching a running Kanban worker (in Score, a dashboard, or a terminal) wants to **stop that attempt**: end
the model work now and keep the task from being picked up again until a person decides. Today there is no operation that
does exactly that:
- `hermes kanban reclaim <task>` tries SIGTERM/SIGKILL on the recorded worker, but a manual reclaim **still releases the
  claim and closes the attempt when signalling was refused or failed** (`kanban_db_dispatch.py:443`, `kanban_db.py:2652`;
  Hermes's own test `test_kanban_worker_pid_fingerprint.py:139` covers an operator reclaim that sends no signal). An ended
  attempt therefore does not prove the worker stopped.
- Reclaim returns the task to `ready`/`review` and resets the failure counter (`kanban_db.py:2641`), so the dispatcher can
  start a successor immediately.
- The CLI takes a **task id** only. A delayed or retried command can reclaim a *successor* attempt rather than the one the
  operator saw; the internal compare-and-set protects the lock read by that command, not the operator's earlier choice.
- `block` holds the task but closes the attempt without immediate termination (terminal-worker cleanup has a grace
  period, `kanban_db_dispatch.py:504`).

## Proposal: `kanban stop`
```
hermes kanban [--board <slug>] stop --attempt <task_runs.id> --claim <claim_lock> [--reason TEXT] [--json] <task_id>
```
1. **Fenced:** refuse (exit code + machine-readable reason) unless `<task_id>`'s *current* attempt is `<attempt>` and its
   claim lock is `<claim>`. A successor attempt is never touched.
2. **Hold first:** move the task to a held state (e.g. `blocked` with kind `operator_stop`, or a new `stopped`) in the
   same transaction as the fence check, so the dispatcher cannot start a successor while termination runs.
3. **Terminate with evidence:** signal the recorded worker only after verifying host and start fingerprint
   (`worker_started_at`), escalate SIGTERM → SIGKILL after a bounded grace, and wait for exit.
4. **Report truthfully:** `--json` returns `{ attempt, held: true, terminated: true|false, evidence: "exited" |
   "not_running" | "fingerprint_mismatch" | "other_host" | "signal_refused", outcome }`. The attempt closes with outcome
   `stopped` only when termination is proven; otherwise it stays open and held, and the caller sees why.
5. **Idempotent:** repeating the same command after success answers the same result.

## How Score would use it
Score keeps the attempt id and claim lock it observed (bridge provenance) and calls `kanban stop` with both; it shows
"Stopped" only on `terminated: true`, and "Held, still running: <evidence>" otherwise. Until Hermes ships this, Score
says Stop is unavailable for Kanban attempts and offers reclaim only as "retry this task".
