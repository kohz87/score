**Verdict: Do not finalize this draft.**  
**Two critical approval flaws allow consent to cover the wrong operation or additional operations.**  
**The stream’s consistency and recovery guarantees require protocols that the draft does not yet define.**

Reviewed read-only against Hermes commit `e97923c38acba2066aff9c45e35fe1584a2155b2`. No files were modified. Findings distinguish demonstrated behavior from missing design invariants.

1. **Critical — Gateway FIFO resolution can approve a replacement request.**

   **Design:** D4 correlates by `session_key` + command and resolves the oldest pending request when ambiguous. [docs/ARCHITECTURE.md:112](/home/raven/score/docs/ARCHITECTURE.md:112)

   **Failure:** Hermes’s resolver accepts neither a command nor a digest. Without `request_id`, it pops whatever is currently first. Sequence: request A appears in Score; Telegram denies A; request B enters the same session; the delayed Score approval for A approves B. Parallel calls are unnecessary. I reproduced this using the exact extracted resolver with an in-memory queue. [Hermes/tools/approval.py:139](/home/raven/reference/hermes-agent/tools/approval.py:139)

   Hermes generates an exact queue request ID, but omits it from the gateway approval hook payload. Redacted command text cannot substitute for that identity. [Hermes/tools/approval_gateway_wait.py:29](/home/raven/reference/hermes-agent/tools/approval_gateway_wait.py:29), [Hermes/tools/approval_gateway_wait.py:149](/home/raven/reference/hermes-agent/tools/approval_gateway_wait.py:149)

   **Change:** Require an exact queued request ID and producer/session generation for every actionable approval. Extend the Hermes hook or establish a verified exact-ID mapping. Refuse resolution when that mapping is unavailable; an “oldest pending” warning does not make authorization safe.

2. **Critical — Kanban “Approve once” grants a pattern for the entire worker.**

   **Design:** Install `approve_permanent(pattern_key)` in the next worker and consume the Score grant when a matching tool succeeds. [docs/ARCHITECTURE.md:124](/home/raven/score/docs/ARCHITECTURE.md:124)

   **Failure:** `approve_permanent` adds a pattern to a process/profile allowlist. It has no execution count, command binding, expiry, or automatic removal. Marking the Score row consumed does not remove that permission. Later or concurrent commands matching “delete in root path” retain permission until worker exit. [Hermes/tools/approval.py:360](/home/raven/reference/hermes-agent/tools/approval.py:360)

   L5 proves process isolation, not single-use consent. The probe installs the grant on every `pre_tool_call`, including `kanban_show` and `kanban_complete`. [docs/spike/score-spike-plugin/**init**.py:65](/home/raven/score/docs/spike/score-spike-plugin/__init__.py:65), [docs/spike/l5-worker-hooks.json:95](/home/raven/score/docs/spike/l5-worker-hooks.json:95)

   **Change:** Implement an atomic, exact-operation grant at the Hermes authorization gate, bound to command digest, cwd, profile and worker attempt. Until that exists, expose this mechanism only as an explicitly described worker-lifetime pattern permission.

3. **High — The decision endpoint establishes no human-only authority.**

   **Design:** Mutations require `X-Score-Client` and a same-origin check; bridge processes share one secret. [docs/ARCHITECTURE.md:158](/home/raven/score/docs/ARCHITECTURE.md:158)

   **Failure:** An agent with local terminal/network access can construct both headers and call `/api/approvals/:id/decision` itself. Same-origin checks constrain browsers, not local HTTP clients. A shared bridge token also provides no authenticated distinction between profiles or producer processes. The contract contains no separate approval principal or restricted bridge capabilities. [docs/API-CONTRACT.md:210](/home/raven/score/docs/API-CONTRACT.md:210), [docs/API-CONTRACT.md:288](/home/raven/score/docs/API-CONTRACT.md:288)

   **Change:** Authenticate browser decisions separately from bridge observations. Restrict each bridge identity to its own events and decisions. If approvals must resist agent tool use, isolate agent execution from Score’s credentials and decision routes; otherwise explicitly limit D7’s guarantee to browser CSRF protection.

4. **High — “Already redacted by Hermes” is false for bridge payloads.**

   **Design:** D7 stores approval payloads as received; Watch also stores commands, arguments and output from hooks. [docs/ARCHITECTURE.md:149](/home/raven/score/docs/ARCHITECTURE.md:149), [docs/ARCHITECTURE.md:162](/home/raven/score/docs/ARCHITECTURE.md:162)

   **Failure:** Tool hooks receive raw `function_args` and `result`, without a redaction pass. CLI command approval hooks can also receive the raw command. Gateway approval preparation calls configurable redaction without `force=True`; Hermes permits disabling regular redaction. [Hermes/model_tools.py:680](/home/raven/reference/hermes-agent/model_tools.py:680), [Hermes/tools/approval.py:907](/home/raven/reference/hermes-agent/tools/approval.py:907), [Hermes/tools/approval.py:850](/home/raven/reference/hermes-agent/tools/approval.py:850), [Hermes/agent/redact.py:880](/home/raven/reference/hermes-agent/agent/redact.py:880)

   Thus credentials in command arguments or tool output can enter Score’s event log, approval ledger and Watch storage.

   **Change:** Specify mandatory redaction/filtering before bridge serialization and before durable Score storage. Redact before truncation. Keep correlation digests separate from displayed command text, and validate secret-bearing fixture cases across every producer.

5. **High — `asOfSeq` does not establish a consistent snapshot.**

   **Design:** Every snapshot returns a global watermark, after which deltas supposedly cannot be lost or applied twice. D5 avoids caching Hermes state. [docs/ARCHITECTURE.md:58](/home/raven/score/docs/ARCHITECTURE.md:58), [docs/ARCHITECTURE.md:142](/home/raven/score/docs/ARCHITECTURE.md:142)

   **Failure:** Reading snapshot rows and then the log head permits this schedule: read old message content; persist its delta at seq 101; return `asOfSeq=101`. The client skips the missing delta. Reading the head first permits the opposite: the snapshot already contains a change subsequently delivered as a delta.

   Independent Hermes databases make this harder: a task mutation can be visible before Score ingests its event. A Score log watermark cannot describe an atomic cut across those databases.

   **Change:** Maintain the projections needed for live snapshots in Score, updating projection rows and the event log in one transaction. Read projection and watermark in one transaction. Treat direct Hermes reads as reconciliation inputs with explicit freshness semantics.

6. **High — Persist-before-fan-out leaves the replay/subscription race unspecified.**

   **Design:** Persistence before fan-out is presented as the central no-gap/no-duplicate guarantee. [docs/ARCHITECTURE.md:56](/home/raven/score/docs/ARCHITECTURE.md:56)

   **Failure:** Reading backlog through N and then registering the subscriber loses N+1 if it arrives between those steps. Registering first and replaying without a fence can duplicate N+1. Persistence alone also does not specify serialized publication when multiple producers submit events.

   Hermes’s own stream attaches its subscriber while capturing replay in one uninterrupted operation; that property must survive Score’s durable implementation. [Hermes/gateway/platforms/api_server_runs.py:147](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:147)

   **Change:** Define a single ordered publication path and an atomic subscription fence: register/buffer, capture head H, replay `(since,H]`, then release buffered events above H. Commit event, projection and ingestion checkpoint together. Require strictly increasing committed sequence numbers; explain whether “gap-free” is actually necessary.

7. **High — Global sequence numbers do not deduplicate or causally order upstream observations.**

   **Design:** Run SSE, bridge hooks and SQLite tailing all become events through `translate.ts`. [docs/ARCHITECTURE.md:24](/home/raven/score/docs/ARCHITECTURE.md:24)

   **Failure:** One tool execution appears through all three channels. A Score-started approval appears both in run SSE and bridge hooks, creating a potential second `gateway` ledger item unless precedence is defined. L4 demonstrates both channels observing API runs. [docs/SPIKE.md:274](/home/raven/score/docs/SPIKE.md:274)

   Arrival order can also invert lifecycle order: a batched bridge request may arrive after its response or after run completion. Assigning a fresh global seq to each arrival preserves these duplicates and inversions. Run SSE tool events omit `tool_call_id`, so reliable matching to hooks cannot be assumed. [Hermes/gateway/platforms/api_server_runs.py:92](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:92)

   **Change:** Define canonical producer ownership per domain event, stable upstream identities and unique ingestion constraints. Persist bridge producer incarnation + counter and upstream SSE cursors. Make secondary channels enrich or reconcile canonical records, with terminal-state guards against delayed observations.

8. **High — Reset and resynchronization can lose changes while snapshots reload.**

   **Design:** After pruning, send `stream.reset` and immediately continue live events; on overflow, disconnect with a reset. The client invalidates queries. [docs/API-CONTRACT.md:95](/home/raven/score/docs/API-CONTRACT.md:95), [docs/ARCHITECTURE.md:63](/home/raven/score/docs/ARCHITECTURE.md:63), [docs/PLAN.md:63](/home/raven/score/docs/PLAN.md:63)

   **Failure:** A live delta can update a cache while a replacement snapshot is fetching; the older snapshot response then overwrites it. One stream also serves snapshots with different watermarks, so one tab-level `lastSeq` cannot decide which events each query has incorporated.

   A saturated socket cannot reliably receive the promised reset frame. The contract also does not define IDs for client-specific `hello/reset` frames, future cursors, or log generations after restore.

   **Change:** Define a resync state machine: buffer events, replace each snapshot, then apply events above that query’s watermark. Cancel or fence stale fetches. Separate control frames from durable event IDs; persist head/prune metadata and handle invalid future cursors. Bound queued bytes and socket write time, making reset delivery best-effort.

9. **High — The SQLite tail cursor is wrong, and messages are not append-only.**

   **Design:** Tail `task_events` and `messages` by `(created_at,id)`. [docs/ARCHITECTURE.md:79](/home/raven/score/docs/ARCHITECTURE.md:79)

   **Failure:** `messages` has `timestamp`, not `created_at`. More fundamentally, Hermes preserves older timestamps when inserting carried or cloned messages and explicitly reads by ID because clocks regress. A later insert with an older timestamp is permanently skipped by the proposed cursor. I confirmed that behavior with in-memory SQLite. [docs/spike/state-schema.sql:160](/home/raven/score/docs/spike/state-schema.sql:160), [Hermes/hermes_state_messages.py:746](/home/raven/reference/hermes-agent/hermes_state_messages.py:746), [Hermes/hermes_state_messages.py:1384](/home/raven/reference/hermes-agent/hermes_state_messages.py:1384)

   ID-only tailing still misses edits, deactivation and deletion of existing rows; compaction creates new physical rows for existing logical messages. [Hermes/hermes_state_messages.py:807](/home/raven/reference/hermes-agent/hermes_state_messages.py:807), [Hermes/hermes_state_messages.py:1120](/home/raven/reference/hermes-agent/hermes_state_messages.py:1120)

   **Change:** Use ID checkpoints for append ingestion, scoped to database incarnation. Reconcile mutable session projections, visibility and compression lineage using logical message/tool identities. Include restore, rewind, edit and compaction fixtures, beyond same-timestamp inserts.

10. **High — Score’s durable log cannot recover events that never reached it.**

    **Design:** Seven-day Score retention and resumable SSE coexist with a bridge that drops events when Score is down. [docs/ARCHITECTURE.md:62](/home/raven/score/docs/ARCHITECTURE.md:62), [docs/PLAN.md:99](/home/raven/score/docs/PLAN.md:99)

    **Failure:** Hermes retains only 1,000 run events in memory. It signals `replay.truncated`; gateway restart loses that transport altogether. Tool-start observations, interim output and approval settlements dropped by the bridge are not generally reconstructible from SQLite. [Hermes/gateway/platforms/api_server_runs.py:116](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:116), [Hermes/gateway/platforms/api_server_runs.py:1115](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:1115)

    Also, SPIKE lists `run.queued/run.started` as wire events, but this Runs API updates those states without emitting those events; the fixtures begin with text/tool events. [docs/SPIKE.md:90](/home/raven/score/docs/SPIKE.md:90), [Hermes/gateway/platforms/api_server_runs.py:258](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:258), [Hermes/gateway/platforms/api_server_runs.py:956](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:956)

    **Change:** Define recovery per source: durable cursors, explicit truncation handling, run-status polling, database reconciliation and visible unrecoverable intervals. Seed lifecycle state from dispatch/status. Use a bounded durable bridge spool if complete replay is a requirement.

11. **High — The bridge decision protocol cannot route decisions safely or deliver Kanban grants.**

    **Design:** Every plugin process long-polls one decision queue. Its response contains only `approvalId`, `sessionKey`, `requestId` and `choice`. [docs/API-CONTRACT.md:291](/home/raven/score/docs/API-CONTRACT.md:291)

    **Failure:** There is no consumer/profile/process-incarnation selector, delivery lease or acknowledgement ownership. A worker can receive a gateway decision that exists only in another process; the semantics of its failed acknowledgement are unspecified.

    For Kanban, the approved worker normally exits and the replacement has a new session ID. The protocol carries neither `taskId` nor `pattern_key`, and defines no grant redemption endpoint. D4’s central mechanism therefore cannot be expressed through the contract.

    **Change:** Add registered, authenticated producer identities and owner-scoped decision delivery with leases and exact-target acknowledgements. Define a separate Kanban grant redemption protocol containing profile, board, task, eligible attempt, command scope, expiry and consumption state.

12. **High — Ledger idempotency is being confused with effect idempotency.**

    **Design:** `requestId` + `Idempotency-Key` supposedly makes every decision reach one terminal state. [docs/ARCHITECTURE.md:139](/home/raven/score/docs/ARCHITECTURE.md:139)

    **Failure:** Gateway request IDs are absent from hooks, and the HTTP idempotency key is optional. More importantly, Score cannot transactionally commit both its ledger and an external effect. Hermes may accept a decision before Score crashes; replay then returns “not pending.” A worker may execute before its success hook is lost, leaving a reusable grant. Hermes’s API returns 409 when no pending target remains. [docs/API-CONTRACT.md:10](/home/raven/score/docs/API-CONTRACT.md:10), [Hermes/gateway/platforms/api_server_runs.py:1203](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:1203)

    **Change:** Persist decision intent, exact target and an outbox before delivery. Separate requested/applied/confirmed/unknown states internally from the approval’s terminal state. Reconcile ambiguous effects; never interpret “not pending” as denial. Reserve execution grants before execution and require human intervention when completion is uncertain.

13. **High — Kanban grants are stale across attempts, and the retry protocol is incomplete.**

    **Design:** Grants are keyed by task + pattern; Score must “apply the grant before unblocking.” Denial leaves the task blocked. [docs/ARCHITECTURE.md:124](/home/raven/score/docs/ARCHITECTURE.md:124)

    **Failure:** The next worker does not exist before unblock. Persisting a grant and installing it in a worker are different operations. Between them, the task can change assignee, body or attempt; an older worker can still be alive. Hermes provides attempt and claim identifiers, but the design ignores them. [Hermes/hermes_cli/kanban_db_dispatch.py:2908](/home/raven/reference/hermes-agent/hermes_cli/kanban_db_dispatch.py:2908)

    The loop guard compares **block kind**, not reason text. Two different capability failures can cause triage. `unblock_task` does not accept triage, and the recorded specifier re-promotes triaged work automatically. [Hermes/hermes_cli/kanban_db.py:3382](/home/raven/reference/hermes-agent/hermes_cli/kanban_db.py:3382), [Hermes/hermes_cli/kanban_db.py:3724](/home/raven/reference/hermes-agent/hermes_cli/kanban_db.py:3724), [docs/spike/l5-task-events.json:165](/home/raven/score/docs/spike/l5-task-events.json:165)

    **Change:** Specify durable grant staging, guarded task transition and attempt-bound redemption before the eligible tool executes. Revalidate task revision/profile and expire stale grants. Define triage handling and an actual dispatch hold for denied work.

14. **Medium — The blocked-worker detector describes the wrong status layer.**

    **Design:** `post_tool_call` “sees `status: blocked`.” [docs/ARCHITECTURE.md:120](/home/raven/score/docs/ARCHITECTURE.md:120)

    **Failure:** The recorded hook’s top-level status is `error`; `blocked` is inside a JSON-encoded `result` string. Hermes’s observer derives `error` whenever that result contains an error. A literal implementation of the draft misses L5’s demonstrated case. [docs/spike/l5-worker-hooks.json:380](/home/raven/score/docs/spike/l5-worker-hooks.json:380), [Hermes/model_tools.py:662](/home/raven/reference/hermes-agent/model_tools.py:662)

    Recomputed dangerous-command keys also do not describe every denial. `execute_code`, for example, denies unattended execution before any permanent approval lookup. [Hermes/tools/approval.py:1273](/home/raven/reference/hermes-agent/tools/approval.py:1273)

    **Change:** Specify decoding and zod validation of the nested result, and restrict redeemable grants to verified denial classes. Preserve other blocks as diagnostics. Add structured Hermes policy metadata before expanding beyond the demonstrated terminal-pattern case.

15. **High — Persistent room sessions need distinct identities and a concurrency policy.**

    **Design:** Room runs reuse `session_id=score:{room}:{agent}` and send the room transcript as `conversation_history`. [docs/ARCHITECTURE.md:87](/home/raven/score/docs/ARCHITECTURE.md:87)

    **Failure:** SPIKE’s `session_id=session_key=run_id` observation applies to fresh runs. Hermes deliberately uses `run_id` as the approval authorization key while retaining the selected conversation session ID; compression can change that session’s live tip. [docs/SPIKE.md:277](/home/raven/score/docs/SPIKE.md:277), [Hermes/gateway/platforms/api_server_runs.py:505](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:505), [Hermes/gateway/platforms/api_server_runs.py:698](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:698)

    Overlapping turns on that session contend on a durable lease. After waiting, Hermes can replace the supplied room history with the persisted per-agent transcript, changing context according to scheduling. [Hermes/agent/turn_facade_lease.py:312](/home/raven/reference/hermes-agent/agent/turn_facade_lease.py:312)

    **Change:** Persist separate run, approval-session, conversation-session and live-tip identities. Serialize room-agent turns and construct their input context after admission. Define how other agents’ room messages enter that context without losing Hermes tool history.

16. **High — D5 omits state that Score cannot reconstruct from Hermes.**

    **Design:** D5 lists tables but says Score caches nothing cheaply rereadable. [docs/ARCHITECTURE.md:142](/home/raven/score/docs/ARCHITECTURE.md:142)

    **Failure:** The contract requires briefs, room-linked tasks, flow node IDs and refs, but D5 provides no durable model for those relationships. Hermes task `session_id` is an originating Hermes session, often null for CLI-created tasks; it is not a Score room or brief association. [docs/API-CONTRACT.md:151](/home/raven/score/docs/API-CONTRACT.md:151), [docs/API-CONTRACT.md:219](/home/raven/score/docs/API-CONTRACT.md:219), [docs/spike/kanban-schema.sql:161](/home/raven/score/docs/spike/kanban-schema.sql:161)

    External run attempts and their room/session mappings also cannot necessarily be reconstructed after the seven-day event log expires, while Reports requests 30 days. Crashing after Hermes creates a task/run but before Score records its association leaves orphaned work.

    **Change:** Add explicit brief/task/room associations, run-attempt mappings for all origins, ingestion checkpoints, grants and durable command intents. Dispatch with stable upstream idempotency keys where supported, then reconcile acceptance before attaching results.

17. **High — The version gate does not cover the actual compatibility boundary.**

    **Design:** Unknown majors degrade; capability-keyed translation supposedly confines upgrades to one file. Private calls live in the Python plugin, with exclusive transport as a fallback. [docs/ARCHITECTURE.md:71](/home/raven/score/docs/ARCHITECTURE.md:71), [docs/ARCHITECTURE.md:195](/home/raven/score/docs/ARCHITECTURE.md:195)

    **Failure:** All `0.x` releases share major zero. Public capabilities do not describe private approval functions, SQLite schemas, CLI output or plugin execution mode. Under `plugins.isolation: host`, this third-party plugin runs in another process, so importing approval functions reaches the wrong memory. Approval transports are also explicitly unsupported there. [Hermes/hermes_cli/plugin_isolation.py:3](/home/raven/reference/hermes-agent/hermes_cli/plugin_isolation.py:3), [Hermes/hermes_cli/plugin_isolation.py:35](/home/raven/reference/hermes-agent/hermes_cli/plugin_isolation.py:35)

    Capabilities are not even a complete endpoint inventory: `jobs_admin:false` coexists with authenticated `/api/jobs` handlers, contradicting SPIKE’s inference. [Hermes/gateway/platforms/api_server.py:67](/home/raven/reference/hermes-agent/gateway/platforms/api_server.py:67), [Hermes/gateway/platforms/api_server.py:3836](/home/raven/reference/hermes-agent/gateway/platforms/api_server.py:3836), [docs/SPIKE.md:235](/home/raven/score/docs/SPIKE.md:235)

    **Change:** Gate against tested builds/schema fingerprints and per-process bridge handshakes, including isolation mode. Declare the Python bridge as a second explicit adapter boundary and enforce the TypeScript boundary beyond imports. Exclusive transport must require a separate policy decision because it replaces the owner-approved additive behavior.

18. **Medium — The promised profile-file editor has no chosen write mechanism.**

    **Design:** Profile writes go through Hermes CLI; the dashboard API is deferred. The contract nevertheless promises etag-protected SOUL/AGENTS editing. [docs/ARCHITECTURE.md:27](/home/raven/score/docs/ARCHITECTURE.md:27), [docs/ARCHITECTURE.md:186](/home/raven/score/docs/ARCHITECTURE.md:186), [docs/API-CONTRACT.md:247](/home/raven/score/docs/API-CONTRACT.md:247)

    **Failure:** The installed `hermes profile` parser has no general file-edit/put command. Creating, describing or updating a distribution does not implement that editor. [Hermes/hermes_cli/subcommands/profile.py:8](/home/raven/reference/hermes-agent/hermes_cli/subcommands/profile.py:8)

    **Change:** Choose a concrete mechanism now: narrowly scoped non-secret file writes inside the adapter with etag validation and atomic replacement, or the dashboard API with its explicit authentication/lifecycle. Preserve the separate prohibition on writing Hermes SQLite.

19. **Medium — Per-profile key rotation can orphan active run control.**

    **Design:** Score creates and stores each profile’s API key. [docs/ARCHITECTURE.md:74](/home/raven/score/docs/ARCHITECTURE.md:74)

    **Failure:** Hermes’s run ownership scope hashes both profile and current API key. Rotating the key changes that scope: the new key cannot control runs admitted under the old scope, while the old key fails authentication. Losing Score’s key copy cannot safely be repaired by generating another key. [Hermes/gateway/platforms/api_server_runs.py:360](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:360), [Hermes/gateway/platforms/api_server_runs.py:1023](/home/raven/reference/hermes-agent/gateway/platforms/api_server_runs.py:1023)

    **Change:** Define profile adoption, key loss and rotation separately. Record credential generation on run mappings; drain active runs and approvals before rotation. Treat missing copies as unavailable credentials, and require explicit adoption/rekeying of existing profiles.

20. **Medium — Guardian phases and resolver attribution do not fit the proposed ledger semantics.**

    **Design:** Guardian decisions become resolved approvals, and the UI identifies who answered and where. [docs/ARCHITECTURE.md:115](/home/raven/score/docs/ARCHITECTURE.md:115), [docs/ARCHITECTURE.md:140](/home/raven/score/docs/ARCHITECTURE.md:140)

    **Failure:** Smart mode emits a pre-hook even when the guardian later escalates, but emits its post-hook only for approve/deny. Turning every pre-hook into a pending human approval leaves an orphan on escalation. A guardian deny can then be followed by a separate human override for the same command. [Hermes/tools/approval_smart.py:134](/home/raven/reference/hermes-agent/tools/approval_smart.py:134), [Hermes/tools/approval.py:808](/home/raven/reference/hermes-agent/tools/approval.py:808)

    Gateway post-hooks report choice/outcome, not resolver identity. They cannot independently prove Telegram answered. Coalesced followers further complicate request counts. [Hermes/tools/approval_gateway_wait.py:89](/home/raven/reference/hermes-agent/tools/approval_gateway_wait.py:89), [Hermes/tools/approval_gateway_wait.py:104](/home/raven/reference/hermes-agent/tools/approval_gateway_wait.py:104)

    **Change:** Model guardian evaluation, human prompt and execution as distinct phases of one operation. Only actual human prompts enter “Needs you.” Attribute Score decisions through confirmed decision delivery; retain unknown external attribution when Hermes provides no actor.

**Things that are fine**

- One browser SSE stream plus REST commands is a suitable transport choice.
- Per-profile API keys and `state.db`, with shared default-board Kanban state, match L3.
- Hermes SQLite reads and CLI/API writes preserve the intended ownership boundary.
- Score-owned rooms, fake-adapter testing, recorded fixtures and neutral agent defaults are sound foundations.
