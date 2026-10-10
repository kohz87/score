# Proposal: per-run execution policy and termination evidence on the Runs API

**For:** Hermes Agent (`api_server_runs`). **Why:** Score's workflow builder (PLAN 7.1) runs agent steps through
`POST /v1/runs` and needs two guarantees it can't get today.

1. **Per-run tool policy.** Let a run request carry `enabled_toolsets` (subset of the profile's api_server toolsets),
   applied when the agent is constructed — the same mechanism hosted room dispatch already uses
   (`room_execution_policy` → `enabled_toolsets`) but available to authenticated API clients without room grants. Score
   would exclude delegation and background-process tools so a step can't outlive its run.
2. **Termination evidence.** Distinguish in `GET /v1/runs/{id}` an outcome reported by the agent loop itself
   (`completed`/`failed`, worker returned) from outcomes set by the gateway (`cancelled` on shutdown/interrupt, expiry),
   e.g. `{ status, terminal_source: 'agent' | 'gateway', worker_exited: bool }`, and keep run records for a documented
   retention so a client can confirm the final state after its own restart.
3. **Lookup by session.** `GET /v1/runs?session_id=` (or by idempotency key) so a client that lost a run id after a crash
   can recover the handle and stop or observe the run.
