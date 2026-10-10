I found 13 defects that remain after the recorded fixes. Six are High severity and block the Phase 1 gate.

1. **High — Secrets survive server redaction.** [redact.ts:13](/home/raven/score/apps/server/src/redact.ts:13)  
   Free-text commands/results containing `apiKey=…`, `AWS_SECRET_ACCESS_KEY=…`, Basic authorization headers, or temporary AWS access keys survive the server scrub. Probes confirmed this. Canonical run SSE/status data can reach this layer without Hermes redaction, allowing secrets into Score’s durable data and logs.  
   **Minimal fix:** align Node’s assignment and header handling with normalized credential-name classification; cover these forms through the gateway-to-storage path.

2. **High — Bridge approval capability is enabled for untested producer builds.** [routes.ts:88](/home/raven/score/apps/server/src/hermes/bridge/routes.ts:88), [fingerprint.ts:117](/home/raven/score/apps/server/src/hermes/live/fingerprint.ts:117)  
   The fingerprint still contains `bridge: null`. Hello records the producer’s plugin/Hermes versions and SHA but does not qualify them; approval enablement uses the default installation’s compatibility status. An inject probe reporting unrelated versions and SHA still received `gatewayApprovals: true`. This bypasses D2.2’s gate for the process actually executing private approval calls.  
   **Minimal fix:** qualify each producer against tested plugin/Hermes/private-API combinations; keep unknown combinations observe-only.

3. **High — Tool completions can close the wrong approval.** [approvals.ts:603](/home/raven/score/apps/server/src/domain/approvals.ts:603)  
   Completion matching selects the newest human approval by producer and `tool_call_id`, ignoring session and gate identity. Hermes explicitly permits repeated tool IDs. With two sessions sharing an ID, a completion from session A updated session B in an in-memory probe. Completion-before-gate replay also matches only the repeated ID and counter order. The gate-ID fix therefore protects prompt pairing but leaves completion attribution unsafe.  
   **Minimal fix:** carry an invocation identifier through pre/post hooks and match completion evidence to that exact invocation. Adding session identity alone does not handle repetitions within a session.

4. **High — Recovery can execute an already completed run again.** [intents.ts:204](/home/raven/score/apps/server/src/hermes/live/intents.ts:204)  
   Recovery retries every `sent`/`unknown` admission regardless of age. Hermes prunes terminal idempotency records after 24 hours: [api_server_run_idempotency.py:169](/home/raven/reference/hermes-agent/gateway/platforms/api_server_run_idempotency.py:169). If admission succeeds but Score crashes before recording the response, an outage beyond that window permits the same recovery POST to create another run and repeat its tool effects.  
   **Minimal fix:** persist first-send time and the supported replay deadline. Beyond it, reconcile acceptance independently or retain `unknown`; do not automatically resubmit an ambiguous admission.

5. **High — Spool eviction can permanently stall bridge delivery.** [sender.py:276](/home/raven/score/hermes-plugin/score_bridge/sender.py:276), [spool.py:375](/home/raven/score/hermes-plugin/score_bridge/spool.py:375)  
   Gap materialization appends its report behind retained batches. If counter 1 was evicted and batches 2 and 3 remain, the server correctly acknowledges batch 2 through counter 0. `_drain()` stops and retries batch 2 forever, never sending the gap report that would unblock acknowledgement. A probe using the actual drain logic reproduced this loop.  
   **Minimal fix:** allow later retained batches and gap reports to be transmitted while preserving unacknowledged records, or prioritize gap delivery without renumbering existing events. Test against contiguous server acknowledgements.

6. **High — Browser reconnects can silently miss durable events.** [stream.ts:90](/home/raven/score/apps/web/src/data/stream.ts:90)  
   Hello stores the epoch but discards `headSeq`. If the connection drops before its first durable event, reconnect has no cursor and starts at the new head, silently skipping intervening changes. A mocked EventSource probe confirmed the cursorless reconnect. Reset handling also leaves stale/future cursors unchanged, causing repeated resets.  
   **Minimal fix:** establish the fresh connection’s cursor from hello’s head; rebase it after reset, while preserving the previous cursor during valid replay.

7. **Medium — Redaction destroys structural session identifiers.** [sender.py:188](/home/raven/score/hermes-plugin/score_bridge/sender.py:188), [redact.ts:45](/home/raven/score/apps/server/src/redact.ts:45)  
   Both scrubbers classify `session_id`/`sessionId` as credentials. The plugin lifts envelope identifiers only after scrubbing, so distinct sessions become `[redacted]`. Gateway JSON similarly loses its real session ID before schema validation. This collapses tool projections and loses session-tip information, despite §11’s identifier-preservation rule.  
   **Minimal fix:** validate and extract structural identifiers before content redaction, preserving their exact values separately from credential-bearing payload fields.

8. **Medium — The approval lock probe does not enforce lease deadlines.** [decisions.py:64](/home/raven/score/hermes-plugin/score_bridge/decisions.py:64), [hermes_private.py:68](/home/raven/score/hermes-plugin/score_bridge/hermes_private.py:68)  
   The added availability check acquires and releases Hermes’s lock, then calls a resolver that acquires it without a timeout. Another thread can take the lock between those operations. A controlled contention probe resolved a request after its lease expired; shutdown can likewise occur during the wait.  
   **Minimal fix:** provide bounded, atomic exact resolution with deadline/cancellation checked inside the same critical section. A separate lock-availability probe cannot provide that guarantee.

9. **Medium — Producer retirement breaks old spool recovery.** [retention.ts:15](/home/raven/score/apps/server/src/hermes/bridge/retention.ts:15), [registry.ts:29](/home/raven/score/apps/server/src/hermes/bridge/registry.ts:29)  
   After 30 inactive days, a fully acknowledged producer can be deleted while its ingest floor remains. If its HTTP acknowledgement was lost, the plugin may still retain that spool indefinitely. Re-hello recreates the producer with acknowledgement zero; retired keys cannot reconstruct the missing prefix, so old events receive acknowledgement zero forever. The pruning/re-hello probe reproduced this.  
   **Minimal fix:** restore acknowledged progress from retained checkpoint state, or preserve a compact identity/progress tombstone for the supported spool replay lifetime.

10. **Medium — Unblock can withdraw the new attempt’s denial card.** [tasks.ts:42](/home/raven/score/apps/server/src/http/tasks.ts:42)  
    The route awaits Hermes’s unblock, then closes every open denial for the task. Unblock can dispatch a new worker that reports another denial before this closure runs. Both old and new cards are withdrawn; the new blocked attempt loses its needs-you card. The current closure function reproduced this with two attempts.  
    **Minimal fix:** capture the old attempt/card identities before the external action and close only those. Sweep closure should also require evidence of a genuinely newer attempt.

11. **Medium — Exhausted run polling abandons tracking until restart.** [runs.ts:185](/home/raven/score/apps/server/src/hermes/live/runs.ts:185), [live-port.ts:283](/home/raven/score/apps/server/src/hermes/live/live-port.ts:283)  
    When SSE fails and the 30-minute fallback expires, the follower is logged and removed while the run remains active in SQLite. Periodic system refresh does not restart it. A long-running job or extended outage can therefore leave status and approvals stale indefinitely.  
    **Minimal fix:** supervise active-run followers with bounded backoff and retry after polling exhaustion.

12. **Medium — Implemented mutations ignore advertised HTTP idempotency.** [approvals.ts:104](/home/raven/score/apps/server/src/http/approvals.ts:104), [tasks.ts:33](/home/raven/score/apps/server/src/http/tasks.ts:33)  
    The contract promises that replaying an `Idempotency-Key` returns the first response, but these routes ignore it. Repeating an approval decision with the same key produced 202 then 409. Comment retries can repeat CLI effects, and unblock retries can affect another attempt.  
    **Minimal fix:** persist request receipts scoped to key, route and request body; replay the original response and reject conflicting key reuse.

13. **Medium — Idle approval sweeps accumulate dedupe keys indefinitely.** [approval-outbox.ts:133](/home/raven/score/apps/server/src/domain/approval-outbox.ts:133), [retire.ts:25](/home/raven/score/apps/server/src/hub/retire.ts:25)  
    Every sweep submits a fresh UUID observation, including empty sweeps. Its source has no retirement checkpoint, so normal retirement never removes these keys. The ten-second timer generates approximately 8,640 permanent keys daily before bridge polling. Empty-sweep and retirement probes confirmed the accumulation.  
    **Minimal fix:** avoid durable dedupe entries for empty/internal work that cannot be redelivered, or give this source an explicit retirement lifecycle.

**Things that are fine**

Pairing/session, CSRF and human guards cover the implemented human mutations; bridge credentials cannot authorize browser API calls. Public reads follow the documented local read model. The core ingest transaction and stream subscription fence are sound. Migration transaction/checksum protections, Hermes read-only SQLite access, private-call boundaries and process argument arrays are correctly implemented in the inspected paths.

Offline validation passed 320 contract tests, 265 server tests and 96 Python tests. Lint, formatting and typechecking passed. Full `pnpm check` and additional filesystem-dependent tests were blocked by sandbox restrictions. The 209-package npm license inventory matched the policy and exact approved exceptions; no forbidden-source use was found.

**Gate verdict: fail.**
