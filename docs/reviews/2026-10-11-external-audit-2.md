# Score 1.0.1: recovered second-pass audit and repair plan
Repository: kohz87/score
Audited commit: 9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0
Previous audited commit: 3349e79fa1580f567e936ade61d593f661002466
Scope: Recovery and presentation of the saved second-pass findings. This document is not a new full-repository audit or a patch release.
Evidence and execution limits
The previous response did not deliver its report. The surviving artifact is findings.json. The reproduction scripts, output logs, and benchmark files named in that artifact were not present in the recovered audit directory. Their historical execution claims are retained below only as attributed notes from that artifact, not as independently verified test results.
During recovery, the exact audited revision of apps/server/src/runtimes/coding/process.ts and selected ranges of apps/server/src/knowledge/vault.ts were fetched again through GitHub. The control flow underlying S2-001, S2-002, S2-004, S2-005, and S2-014 was rechecked. No application source was changed or committed.
No complete checkout, build, typecheck, Vitest, Playwright, pytest, live Hermes run, or power-loss test was executed during this recovery. The original artifact also says its full repository suite was not run. Findings apply to the pinned commit, not to unexamined later changes.
Historical evidence labels from the saved artifact: R = isolated mechanism reported exercised; S = source-traced; C = conditional risk. An R label below is not a claim that its reproduction was rerun during recovery.
Summary
Priority    Findings
P1    5
P2    20
P3    2
Total    27


The saved prior-finding recheck classifies 26 of the first 34 findings as source-addressed and eight as partial. Source-addressed is a code assessment, not a passing-test or production-fix guarantee.
Repair sequence
1. Process ownership and stopping: S2-004 through S2-009. Establish supervision before fallible bookkeeping; prevent cancelled work from launching; persist terminal outcomes reliably; keep admission and dispatch capabilities consistent.
2. File publication and moves: S2-001 through S2-003, S2-013, S2-014, S2-022, and S2-027. Preserve no-replace behavior across callers and platforms; make recovery converge without overwriting unrelated edits.
3. Workflow, client state, and cancellation: S2-010 through S2-012. Use safe keyed records, clear completed local commands, and propagate actual network cancellation.
4. Knowledge indexing and import validation: S2-015 through S2-021. Preserve unverified paths, announce removals, reconstruct Git tracking, unify note validation, and replace quadratic parsing paths.
5. Cross-process coordination and maintenance: S2-023 through S2-026. Make integrity scrubbing fair, coordinate password writers, recover retired sender incarnations, and join active recovery at shutdown.
Findings index
ID    Priority    Historical evidence    Finding
S2-001    P1    R    The new knowledge move helper can delete a concurrent replacement of its source
S2-002    P1    R    The unsupported-hard-link fallback silently restores the destination-overwrite race
S2-003    P1    R    Document uploads and ZIP imports bypass no-overwrite publication
S2-004    P1    R    A process-recording failure leaves a spawned child running without supervision
S2-005    P1    R    Stop and the wall-clock limit stop supervising a group when its leader exits
S2-006    P2    S    A requested coding-run model is recorded but not passed to the CLI
S2-007    P2    S    Stop during asynchronous preflight still permits a new child to launch
S2-008    P2    S    A failed terminal observation is swallowed after the runtime forgets the active run
S2-009    P2    S    Orchestration preflight can accept coding agents that its executor cannot dispatch
S2-010    P2    R    Valid constructor identifiers are read as inherited object properties
S2-011    P2    S    A later compaction from another browser reopens an already completed busy state
S2-012    P2    S    Snapshot cancellation is not propagated into existing network fetchers
S2-013    P2    R    The move-plan path disables Knowledge for a valid linked Git worktree
S2-014    P2    S    Deleting a completed backlink rewrite can permanently block move recovery
S2-015    P2    S    Individual stat failures still become false deletion evidence
S2-016    P2    S    Invalidating a document removes it from the index without announcing the change
S2-017    P2    S    Rebuilding the disposable index changes a tracked document into an unversioned document
S2-018    P2    S    ZIP note imports bypass embedded-image validation used by ordinary saves
S2-019    P2    S    The accepted .markdown extension is incompatible with note writing and scanning
S2-020    P2    R    The repaired Markdown parser still rewrites literal code inside lists and blockquotes
S2-021    P2    R    Quadratic array rebuilding makes modest Markdown inputs block the event loop
S2-022    P3    S    A successful move response does not identify backlink rewrites skipped for conflict
S2-023    P3    S    The bounded media scrub never advances beyond a retained prefix of the store
S2-024    P2    R    The password setter is not atomic against the host password command
S2-025    P2    S    Reloading the bridge in a live gateway strands the retired sender outbox
S2-026    P2    C    In-flight hold recovery is still outside the shutdown join
S2-027    P2    C    The new move plan is not durably ordered before filesystem mutation


Detailed findings
S2-001: The new knowledge move helper can delete a concurrent replacement of its source
Priority: P1
Historical evidence: R
Classification: new regression
Related first-pass findings: SCORE-004
Source: apps/server/src/knowledge/vault.ts; moveNoReplace; moveNote
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Source: apps/server/src/knowledge/documents.ts; move
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/documents.ts
Trigger: A note or document is moved while an external editor atomically replaces its source file after the destination hard link is created.
Mechanism: moveNoReplace performs await fs.link(source, dest), then await fs.unlink(source). The second pathname lookup can name a different inode. Linking preserves the original contents at the destination, but unlinking then removes the newly saved external edit. The note-move plan does not protect this live-operation interval. Document moves share the helper.
Impact: The move can report success while the latest source content is lost. This introduces the source-replacement failure previously identified in the workspace into the newly introduced knowledge helper.
Repair direction: Use an atomic no-replace move primitive where supported, with a supported platform implementation. Do not substitute link followed by an unconditional source unlink. If the platform cannot provide the intended guarantee, refuse or expose a non-destructive copy operation. A second stat alone is not an atomic solution.
Required regression test: Suspend immediately after linking, replace the source using an external rename, and resume. Verify the replacement survives and that the operation does not claim a completed move of the newer file. Exercise both note and document callers.
Recovery source check: Source re-read during recovery: KnowledgeVault.moveNoReplace links the source and then unconditionally unlinks its pathname.
Historical verification note from the saved audit; supporting scripts/logs not recovered: reproduce.mjs: real temporary files, deterministic external source replacement, selected helper transcribed without changing control flow. Destination retained "original"; source disappeared; "new external edit" was lost.
Qualification: This requires a concurrent external writer. It is not a claim that uncontended moves always lose data.
S2-002: The unsupported-hard-link fallback silently restores the destination-overwrite race
Priority: P1
Historical evidence: R
Classification: residual
Related first-pass findings: SCORE-002
Source: apps/server/src/knowledge/vault.ts; moveNoReplace
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Trigger: Hard-link creation returns EPERM, ENOSYS, or EOPNOTSUPP, and another process creates the destination after the fallback existence check.
Mechanism: The fallback awaits lstat(dest), then invokes ordinary fs.rename(source, dest). On a filesystem with replacing rename semantics, the gap allows a new destination to be overwritten. An error other than absence from lstat is also treated as nonexistence. The helper advertises no-replace behavior but makes it dependent on the filesystem.
Impact: A note/document move or a new-note publication can destroy the destination created by another writer. The ordinary hard-link success path fixes the old destination race; the fallback does not.
Repair direction: Keep no-replace semantics mandatory across fallback paths. Use an atomic platform primitive or fail closed with an actionable unsupported-operation error. Distinguish ENOENT from permission and I/O failures.
Required regression test: Inject an unsupported-hard-link error and create the destination immediately after the absence check. Require a conflict and byte-for-byte preservation of the destination. Repeat with a destination stat permission error.
Recovery source check: Source re-read during recovery: unsupported-link fallback still performs lstat followed by ordinary rename.
Historical verification note from the saved audit; supporting scripts/logs not recovered: reproduce.mjs: injected EOPNOTSUPP followed by real filesystem operations reproduced replacement of "external destination" by "incoming".
Qualification: The hard-link error is deliberately injected; this was not a survey of network filesystems or operating systems.
S2-003: Document uploads and ZIP imports bypass no-overwrite publication
Priority: P1
Historical evidence: R
Classification: newly identified adjacent gap
Related first-pass findings: SCORE-002
Source: apps/server/src/knowledge/documents.ts; place; upload; unzip
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/documents.ts
Source: apps/server/src/knowledge/vault.ts; atomicWrite
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Trigger: An upload/import using a non-replacing conflict policy passes its existence check, then an external process creates the target before publication.
Mechanism: The document placement path and the ZIP note branch call vault.atomicWrite without expect. The new no-replace path inside atomicWrite is selected only for expect.hash === null. Without it, publication still uses a replacing rename, even when the earlier upload policy was ask or keep.
Impact: A user-selected non-overwriting import can overwrite content created concurrently. The central helper improvement does not protect callers that do not pass the required precondition.
Repair direction: Carry conflict policy and expected target identity into every publication call. New destinations need an atomic absence precondition; explicitly replacing destinations need a version precondition where supported. Share this preparation between single uploads and ZIP imports.
Required regression test: Use actual upload and ZIP routes with a hook between conflict resolution and publication. Create an external file at the chosen path and verify ask/keep never replaces it. Include both document and Markdown entries.
Historical verification note from the saved audit; supporting scripts/logs not recovered: reproduce.mjs exercised the actual publication branch selected by these callers using real temporary files. It reproduced external content replacement, but did not execute the Fastify routes.
S2-004: A process-recording failure leaves a spawned child running without supervision
Priority: P1
Historical evidence: R
Classification: newly identified
Source: apps/server/src/runtimes/coding/process.ts; spawnCli
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/runtimes/coding/process.ts
Source: apps/server/src/runtimes/coding/service.ts; recordProcess; execute
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/runtimes/coding/service.ts
Trigger: The child process is successfully spawned, but the synchronous onSpawn callback fails, for example because its coding_processes database write fails.
Mechanism: spawnCli invokes onSpawn before installing its timers, output handlers, close/error handlers, and returned stop interface. The callback exception unwinds the function. The caller can record preparation failure, but no CliRun handle was returned and the detached child already exists.
Impact: The application can show a failed run while executable work continues outside its active process tracking. Recovery may also lack the durable process row needed to find it.
Repair direction: Install supervision and exception handling before invoking fallible bookkeeping. On bookkeeping failure, terminate and reap the complete process group before propagating failure. Prefer durable admission metadata before launch, while still handling the spawn-to-record crash interval explicitly.
Required regression test: Make onSpawn throw after a harmless long-running test child starts. Require the child/group to be gone, no unhandled events, and a terminal visible outcome. Test the same failure with an actual database-write rejection.
Recovery source check: Source re-read during recovery: onSpawn is invoked before signal helpers, stream/error handlers, timers, and the returned control handle are installed.
Historical verification note from the saved audit; supporting scripts/logs not recovered: process-reproductions.mjs executed the SHA-verified process module with a harmless Node child. The function threw, the child remained alive, and no stop handle was returned. The test explicitly killed the group afterward.
S2-005: Stop and the wall-clock limit stop supervising a group when its leader exits
Priority: P1
Historical evidence: R
Classification: newly identified
Source: apps/server/src/runtimes/coding/process.ts; stop; groupGone; done
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/runtimes/coding/process.ts
Source: apps/server/src/runtimes/coding/service.ts; execute; forgetProcess
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/runtimes/coding/service.ts
Trigger: A CLI leader exits while a descendant remains alive, either holding inherited standard I/O open or running with detached/ignored standard I/O.
Mechanism: stop returns immediately when child.exitCode or child.signalCode is set. groupGone is performed only after a stop was recorded. With inherited I/O, close and done can remain pending while the timeout and explicit Stop both do nothing. With ignored I/O, done can resolve on a successful leader exit and the caller can forget the process record while a descendant continues.
Impact: One variant hangs the run queue and potentially shutdown; the other reports completion while background work remains alive. These are two observable consequences of the same leader-versus-group ownership error, counted once.
Repair direction: Define and supervise the lifetime of the whole owned execution group, not just the leader. Allow Stop to act after leader exit, reconcile surviving descendants before completion, and retain durable ownership while any may remain. Account for process-group identifier reuse and escaped descendants in the platform strategy.
Required regression test: Test a leader that spawns a harmless worker and exits for both inherited-I/O and ignored-I/O configurations. Require timeout and Stop to terminate the worker and done to settle only according to the documented group policy.
Recovery source check: Source re-read during recovery: stop returns on leader exitCode/signalCode, and groupGone is skipped when no stop was recorded.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Two checks in process-reproductions.mjs executed the SHA-verified module. An inherited-I/O worker survived both a 150 ms configured wall limit and explicit Stop; another survived successful done resolution. All test groups were cleaned up.
S2-006: A requested coding-run model is recorded but not passed to the CLI
Priority: P2
Historical evidence: S
Classification: newly identified
Source: apps/server/src/runtimes/coding/service.ts; startRun; execute
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/runtimes/coding/service.ts
Source: apps/server/src/domain/routing-dispatch.ts; pump
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/domain/routing-dispatch.ts
Source: apps/server/src/runtimes/coding/codex.ts; buildArgs
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/runtimes/coding/codex.ts
Trigger: A room turn selects a model different from the coding agent default, or the default changes between admission and execution.
Mechanism: The dispatcher passes job.model. startRun stores req.model ?? agent.model in its intent and run row, but execute receives only the input, admitted agent, and room. Its driver.buildArgs call uses the freshly loaded agent.model rather than the admitted/requested model.
Impact: The model actually invoked can differ from the user selection and from the run record. This affects behavior, cost interpretation, and reproducibility.
Repair direction: Carry the effective admitted model through the execution record and into driver arguments. If changing queued runs to a new default is intentional, represent that transition explicitly and keep the run metadata consistent with the launched model.
Required regression test: Set agent default A, request model B, and inspect both the admitted database row and the fake CLI argv. Both must identify B. Then change the default while the turn is queued.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Source-traced across the dispatcher, runtime, and a driver that honors its supplied model. No real CLI/model invocation was performed.
S2-007: Stop during asynchronous preflight still permits a new child to launch
Priority: P2
Historical evidence: S
Classification: newly identified
Source: apps/server/src/runtimes/coding/service.ts; execute; requestStop
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/runtimes/coding/service.ts
Trigger: A stop request arrives after execute checks stopBeforeStart but while CLI detection, workspace checking, or the running observation is awaited.
Mechanism: Those awaits are followed by spawnCli without another cancellation check. The code does check stopBeforeStart afterward, but at that point it sends Stop to a process that has already been launched.
Impact: Work can begin after the user has stopped a still-unlaunched queued turn. Immediate signaling is not equivalent to preventing execution; startup code or tools can act before the signal is processed.
Repair direction: Recheck cancellation and shutdown at the final admission boundary immediately before spawning, and between fallback attempts. Do not perform a visible queued-to-running transition for a turn that should never launch.
Required regression test: Hold CLI detection or the running-observation promise, issue Stop, then resolve the promise. Assert the injected spawn function is never called and the run reaches the appropriate cancelled/interrupted state.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Source-traced asynchronous interleaving. This particular service-level path was not executed.
S2-008: A failed terminal observation is swallowed after the runtime forgets the active run
Priority: P2
Historical evidence: S
Classification: newly identified
Source: apps/server/src/runtimes/coding/service.ts; finish; execute; startRun queue cleanup
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/runtimes/coding/service.ts
Trigger: A CLI ends, but committing its terminal observation fails because of a transient database/ingestion error or validation failure.
Mechanism: finish catches the rejection and reports it only through onError. The surrounding queue can consequently complete and remove the active entry as though terminal persistence succeeded. There is no durable terminal-outcome retry in this path, and the process row may already have been removed.
Impact: A finished process can leave its run queued/running and its reply streaming until a separate recovery path intervenes. Subsequent controls lack the original live execution handle.
Repair direction: Separate process termination from durable result delivery. Retain a retryable terminal outcome until ingestion confirms it, with bounded retry/backoff and an explicit degraded state. Do not turn a failed completion commit into silent success.
Required regression test: Reject the first terminalObservation submission, then recover ingestion. Require the same terminal result to be retried without relaunching the CLI and without leaving a streaming reply behind.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Source-traced failure path, not a database fault-injection integration run.
Qualification: This requires a persistence failure; it is not asserted for successful terminal commits.
S2-009: Orchestration preflight can accept coding agents that its executor cannot dispatch
Priority: P2
Historical evidence: S
Classification: newly identified
Source: apps/server/src/start-server.ts; Orchestrator construction; CodingRuntime construction
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/start-server.ts
Source: apps/server/src/app.ts; buildApp
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/app.ts
Source: apps/server/src/http/orchestrations.ts; preflight/create routes
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/http/orchestrations.ts
Source: apps/server/src/domain/orchestration/executor.ts; preflight; dispatch
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/domain/orchestration/executor.ts
Source: apps/server/src/runtimes/coding/port.ts; withCodingAgents
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/runtimes/coding/port.ts
Trigger: A request includes a coding agent as an allowed orchestration worker and receives the merged team list used by the HTTP routes.
Mechanism: startServer constructs Orchestrator with the raw Hermes port before constructing the coding runtime. buildApp wraps only its own local port variable with withCodingAgents. The routes pass that merged list to preflight/create, which checks identity, readiness, and lifecycle but not dispatch support. The executor retains its raw Hermes startRun boundary.
Impact: An API configuration can pass readiness validation and be stored even though subsequent work for that agent reaches the wrong runtime. A UI that filters such agents does not repair the API/executor mismatch.
Repair direction: Choose one supported contract: reject non-Hermes workers consistently at preflight/create, or inject the same capability-aware merged execution port into the executor. Verify stop/recovery as well as start before enabling a runtime.
Required regression test: Construct the real application wiring with a fake Hermes port and a fake coding runtime. Include a coding worker in preflight and create; require either an explicit unsupported response or dispatch exclusively to the coding fake.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Source-traced object wiring and admission checks. No production orchestration was launched.
Qualification: This does not assume coding-agent orchestration is a promised feature. Rejecting unsupported combinations is a valid fix.
S2-010: Valid constructor identifiers are read as inherited object properties
Priority: P2
Historical evidence: R
Classification: new regression and adjacent validation gap
Source: apps/web/src/routes/workflows/workflow-layout.ts; moveNode; layoutOf
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/web/src/routes/workflows/workflow-layout.ts
Source: apps/server/src/domain/workflows/runs.ts; validateInputs
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/domain/workflows/runs.ts
Source: packages/contract/src/workflows.ts; NodeIdSchema; InputNameSchema
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/packages/contract/src/workflows.ts
Trigger: A workflow contains the allowed identifier constructor as a node without an explicit saved position, or as an omitted optional start input.
Mechanism: The schemas permit constructor. Plain-object lookups treat the inherited Object constructor as a present value. moveNode chooses it ahead of the actual drawing position and saves undefined coordinates. validateInputs reads the same inherited function instead of undefined and attempts string operations/iteration.
Impact: Moving a different node can make the layout invalid and unsavable. A valid optional input name can make a start request fail with TypeError rather than pass validation. Both are one unsafe map-key assumption, counted together.
Repair direction: Use Map, null-prototype records, or own-property checks at every externally named key lookup. Keep schema and runtime treatment aligned; silently reserving a previously valid name requires compatibility handling.
Required regression test: Pin a workflow containing constructor by moving a different node and validate the serialized layout. Start a definition with an omitted optional constructor input, then with explicit empty and nonempty values. Add prototype-named cases wherever schemas allow them.
Historical verification note from the saved audit; supporting scripts/logs not recovered: focused-logic-checks.mjs executed the SHA-verified moveNode helper and produced constructor: {} after JSON serialization. A separately transcribed validateInputs body reproduced TypeError for the omitted input. Rendering and HTTP integration were not executed.
S2-011: A later compaction from another browser reopens an already completed busy state
Priority: P2
Historical evidence: S
Classification: newly identified
Source: apps/web/src/routes/chat/ContextMeter.tsx; MeterView running/answeredId/busy; run
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/web/src/routes/chat/ContextMeter.tsx
Source: apps/web/src/routes/chat/room-actions.ts; sessionContextQuery
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/web/src/routes/chat/room-actions.ts
Trigger: Browser A starts command A and receives its completion; browser B later completes another compaction for the same session.
Mechanism: MeterView retains running = A even after its matching result arrives. It computes busy by comparing that retained ID with only the latest compaction command ID. The reducer later replaces the latest result with B, making A != B and setting busy true again. No code clears A upon matched completion.
Impact: Browser A can show Compacting indefinitely after both operations have actually ended, hiding the normal result/control state until the component is reset.
Repair direction: Track completion of the locally pending command and clear pending state when that exact terminal result arrives. Treat later external compactions as independent updates. Provide authoritative command reconciliation after missed events/reset rather than relying on one latest-event slot.
Required regression test: Mount two session views, complete A, then publish B. Browser A must remain idle and display the newer result appropriately. Also test a result arriving before the POST promise resolves.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Source-traced React state machine; the smaller running/answeredId expression was executed in focused-logic-checks.mjs. No React browser test was run.
S2-012: Snapshot cancellation is not propagated into existing network fetchers
Priority: P2
Historical evidence: S
Classification: residual integration gap
Related first-pass findings: SCORE-015
Source: apps/web/src/data/resync.ts; StreamQueryDefinition; refetch; abortable
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/web/src/data/resync.ts
Source: apps/web/src/routes/chat/room-actions.ts; sessionContextQuery.fetch
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/web/src/routes/chat/room-actions.ts
Trigger: A snapshot is superseded, times out, or loses its observers while a fetch definition does not consume the supplied AbortSignal.
Mechanism: The registry now passes a signal and races the resulting promise against cancellation. The concrete sessionContextQuery fetcher still accepts no signal and calls apiFetch without one. Rejecting the wrapper stops using the result but does not cancel the underlying fetch. Repeated attempts can therefore overlap actual requests despite the registry comment describing one request per entry.
Impact: The fix improves logical recovery but does not provide its intended network/work bound for this call site. Slow requests can continue consuming browser and server resources after replacement.
Repair direction: Thread the signal through every StreamQueryDefinition fetcher and its API calls, and audit the remaining definitions for the same omission. Test observable underlying fetch cancellation, not merely rejection of the registry wrapper.
Required regression test: Use a delayed fetch mock that records signal abortion. Trigger timeout, supersession, idle eviction, and disposal; require the old network call to receive cancellation and no stale result to apply.
Historical verification note from the saved audit; supporting scripts/logs not recovered: The cancellation-versus-underlying-work distinction was exercised in a smaller promise check. The concrete missing signal was confirmed in source; TanStack/network integration was not run.
Qualification: The updated buffer limit and follow-up scheduling are genuine improvements. This finding does not claim those old branches remain unchanged.
S2-013: The move-plan path disables Knowledge for a valid linked Git worktree
Priority: P2
Historical evidence: R
Classification: new regression
Source: apps/server/src/knowledge/vault.ts; planFile; recoverMove; clearPlan; start
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Source: apps/server/src/start-server.ts; KnowledgeVault.start failure handling
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/start-server.ts
Trigger: The configured vault is a linked Git worktree, whose .git entry is a file pointing to its administrative directory.
Mechanism: planFile appends score-move-plan.json beneath root/.git as though .git were always a directory. recoverMove receives ENOTDIR when reading this path. Its catch handles only ENOENT as harmless, then calls clearPlan, which also throws ENOTDIR. Startup recovery consequently fails even when there is no interrupted move.
Impact: The application can disable the entire Knowledge capability for a vault that Git itself recognizes as a valid working tree.
Repair direction: Resolve administrative paths through Git, for example git rev-parse --git-path with appropriate path normalization. Do not assume .git is a directory. Gracefully distinguish a missing plan from an unusable plan location.
Required regression test: Create an actual repository and linked worktree, start Knowledge there, and perform/recover a move. Repeat with a normal repository and with Git unavailable.
Historical verification note from the saved audit; supporting scripts/logs not recovered: reproduce.mjs created a real Git worktree. Git recognized it, while both plan read and forced plan removal failed with ENOTDIR. The full KnowledgeVault class was not booted in this fixture.
S2-014: Deleting a completed backlink rewrite can permanently block move recovery
Priority: P2
Historical evidence: S
Classification: new recovery edge case
Source: apps/server/src/knowledge/vault.ts; finishMove; recoverMove; indexFile
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Trigger: A multi-file move is interrupted after some rewrite items are persisted as done. Before recovery, an external editor deletes one of those already completed backlink notes.
Mechanism: finishMove skips done items when applying rewrites, but later calls indexFile for every done, non-skipped path. The deleted note yields 404. The plan is not cleared, and recoverMove can fail at the same point on each subsequent startup.
Impact: An unrelated external deletion can wedge recovery and, through Knowledge startup failure handling, disable the vault feature. The durable plan creates a retry path but not a convergent one for this case.
Repair direction: Revalidate all recovery items before indexing. Represent deletion or later changes as explicit conflicts, preserve independent external operations, finish the remaining safe work, and surface skipped paths without failing global startup.
Required regression test: Interrupt after a rewrite is marked done, remove that file externally, and restart twice. Both startups must succeed, the deletion must remain preserved, and the move plan must reach a stable completed/conflicted outcome.
Recovery source check: Source re-read during recovery: finishMove indexes completed non-skipped paths without tolerating later deletion.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Source-traced deterministic recovery path. A complete database-backed restart test was not executed.
S2-015: Individual stat failures still become false deletion evidence
Priority: P2
Historical evidence: S
Classification: residual
Related first-pass findings: SCORE-019
Source: apps/server/src/knowledge/vault.ts; walk; scan
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Source: apps/server/src/knowledge/documents.ts; scan
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/documents.ts
Trigger: Directory enumeration succeeds, but lstat for a previously indexed note/document fails transiently for a reason other than genuine disappearance.
Mechanism: The new coverage tracking protects subtrees whose directory read fails. The per-file lstat catch still skips the entry without recording that individual path as unverified. The subsequent removal pass sees an absent, covered path and removes its index entry.
Impact: A temporary filesystem or permission error can still remove existing content from search/tree state and emit a deletion event. A later successful scan may repair it, but the false deletion has already been presented.
Repair direction: Propagate coverage/verification status for individual entries as well as directories. Distinguish confirmed ENOENT from EACCES and other I/O failures, retaining prior index state for unverified paths.
Required regression test: Let readdir return a known file and inject EACCES or EIO into only that file stat. Require no index removal or deleted event. Then restore access and verify normal scanning.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Source-traced scan/removal path. No OS permission fault integration run was performed.
S2-016: Invalidating a document removes it from the index without announcing the change
Priority: P2
Historical evidence: S
Classification: newly identified
Source: apps/server/src/knowledge/documents.ts; ingestExisting; scan
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/documents.ts
Trigger: An externally edited, previously indexed document becomes oversized, ceases to be a regular supported file, or no longer matches its expected type.
Mechanism: ingestExisting removes the existing index row but returns false. scan treats false as no change and does not append the path to changed, so it emits no knowledge.changed event for that removal.
Impact: The server index and an already open browser can disagree indefinitely until another invalidation or refresh occurs. Search, the file tree, and counts can show a document no longer present in the authoritative index.
Repair direction: Return an explicit outcome such as unchanged, upserted, removed, or unreadable. Publish removals when state actually changed, while retaining prior state for merely unreadable files.
Required regression test: Index a valid document, replace it externally with invalid bytes, run scan with announce enabled, and assert both row removal and one coherent notification. Verify that an already invalid unindexed file does not repeatedly emit.
Historical verification note from the saved audit; supporting scripts/logs not recovered: The return-value/notification logic was exercised in a simplified state check; the full document worker and database pipeline were not executed.
S2-017: Rebuilding the disposable index changes a tracked document into an unversioned document
Priority: P2
Historical evidence: S
Classification: newly identified
Source: apps/server/src/knowledge/documents.ts; ingestExisting; versioned decision
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/documents.ts
Source: apps/server/src/knowledge/vault.ts; rebuild
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Source: apps/server/src/knowledge/doc-types.ts; MAX_VERSIONED_BYTES
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/doc-types.ts
Trigger: A document was versioned while at or below 10 MiB, then grew above that threshold while retaining its existing versioned status, and the Knowledge index is rebuilt.
Mechanism: ingestExisting preserves versioning with size <= MAX_VERSIONED_BYTES || known.versioned === 1. rebuild deletes the rows that provide known.versioned, and the fresh scan classifies the same large, already Git-tracked file as unversioned. It does not recover the status from Git tracking.
Impact: A supposedly disposable-index rebuild alters history availability and subsequent versioning behavior. Existing Git history is not itself erased, but the application no longer consistently treats the document as tracked.
Repair direction: Derive tracking status from Git or persist it outside disposable index state. A rebuild must reconstruct the same semantic state rather than reapply first-upload size policy to established files.
Required regression test: Version a small document, grow it to 12 MiB while retaining tracking, rebuild, and compare versioned status/history operations before and after. Include restore and deletion behavior.
Historical verification note from the saved audit; supporting scripts/logs not recovered: The before/after versioning predicate was exercised in a smaller logic check. No full 12 MiB document extraction or rebuild integration run was performed.
S2-018: ZIP note imports bypass embedded-image validation used by ordinary saves
Priority: P2
Historical evidence: S
Classification: newly identified
Source: apps/server/src/knowledge/documents.ts; prepare; unzip
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/documents.ts
Source: apps/server/src/knowledge/vault.ts; writeNote
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Source: apps/server/src/knowledge/note-images.ts; validateNoteImages
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/note-images.ts
Trigger: A ZIP contains a text-valid Markdown note with an embedded image that ordinary note saving would reject, such as an unsupported data-image type or an excessive image payload.
Mechanism: The ZIP note branch directly calls atomicWrite and indexNote. Its preparation validates the general text/type/size rules, but does not invoke validateNoteImages. Ordinary writeNote does invoke that function.
Impact: Import and edit paths disagree about allowed content. A ZIP can create a note that is accepted initially but fails a later ordinary save, or bypasses the documented per-image validation policy.
Repair direction: Centralize note-content preparation and validation, and reuse it for ZIP extraction, single-file uploads, restores where appropriate, and ordinary writes. Keep import-level errors explicit rather than letting one bad entry silently create an uneditable note.
Required regression test: Compare ordinary upload and ZIP import of identical notes containing invalid base64, unsupported image MIME, mismatched magic bytes, and oversized embedded images. Outcomes should match.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Source-traced validation-path mismatch. No browser exploit or executable-content test was attempted.
Qualification: This is not a demonstrated XSS vulnerability. Browser sanitization and rendering boundaries were not shown to fail.
S2-019: The accepted .markdown extension is incompatible with note writing and scanning
Priority: P2
Historical evidence: S
Classification: newly identified
Source: apps/server/src/knowledge/doc-types.ts; classifyName
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/doc-types.ts
Source: apps/server/src/knowledge/note.ts; parseNotePath
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/note.ts
Source: apps/server/src/knowledge/vault.ts; walk
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Source: apps/server/src/knowledge/documents.ts; upload; unzip
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/documents.ts
Trigger: The user uploads or imports a file named chapter.markdown, an extension explicitly recognized as a note.
Mechanism: classifyName recognizes md, markdown, and txt, but only converts txt to md. parseNotePath and the filesystem walk recognize only .md. The direct upload therefore reaches a writer that rejects the classified name. The ZIP branch can write/index the file directly, after which ordinary opening or later scans disagree.
Impact: A supported-looking upload can fail unexpectedly, or an imported file can become inaccessible/unlisted through the note interface despite remaining on disk.
Repair direction: Normalize .markdown to .md at the same boundary as .txt, with consistent conflict resolution, or deliberately support both extensions across paths, scans, routes, links, and exports.
Required regression test: Upload and ZIP-import .md, .markdown, .txt, and case variants, then open, scan, rename, export, and restart. Every accepted file must remain discoverable and editable.
Historical verification note from the saved audit; supporting scripts/logs not recovered: The literal classification and path predicates were exercised in focused-logic-checks.mjs. End-to-end upload/import tests were not run.
S2-020: The repaired Markdown parser still rewrites literal code inside lists and blockquotes
Priority: P2
Historical evidence: R
Classification: residual
Related first-pass findings: SCORE-021
Source: apps/server/src/knowledge/links.ts; blockCodeRanges; codeRanges; parseWikilinks; rewriteLinks
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/links.ts
Trigger: A note contains a fenced code block nested in a list with blank lines, or indented code nested inside a blockquote, and a referenced-looking note name is moved.
Mechanism: The custom block parser does not fully model Markdown containers. In the tested examples, it returns no code range for the nested literal text, then parseWikilinks treats [[Target]] as a live link and rewriteLinks replaces it.
Impact: Renaming a note changes code examples that should remain literal. Backlink extraction is also incorrect for these cases. Fixes for simple fences and escapes do not cover nested block structure.
Repair direction: Use a container-aware Markdown tokenizer or parse block/container structure before link extraction. Maintain one shared source-range interpretation for indexing, headings, images, and rewrite operations.
Required regression test: Add the exact list-contained fence and blockquote-indented-code fixtures in links-results.json. Require codeRanges to exclude their literal contents and rewriteLinks to leave the entire input unchanged.
Historical verification note from the saved audit; supporting scripts/logs not recovered: links-reproductions.mjs ran the SHA-verified links module and changed Target to Renamed in both code examples. A separate CommonMark parser confirmed both examples were code blocks.
S2-021: Quadratic array rebuilding makes modest Markdown inputs block the event loop
Priority: P2
Historical evidence: R
Classification: new regression with related pre-existing hot path
Source: apps/server/src/knowledge/links.ts; codeRanges byLength buckets; buildNoteIndex suffix buckets
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/links.ts
Source: apps/server/src/knowledge/note.ts; noteTitle
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/note.ts
Trigger: A note has many short inline-code spans of the same delimiter length, or a large vault has many notes sharing a basename such as README.md.
Mechanism: For each backtick run, codeRanges replaces the entire same-length candidate array with [...old, position]. Total copied entries grow quadratically. buildNoteIndex similarly recopies each shared suffix bucket. These synchronous routines are used in indexing and other request/scan paths.
Impact: A 128,000-byte inline-code sample took 13,954 ms in the isolated test, despite being far below the note-size limit. It can stall other JavaScript work in the same process. Common-basename indexing has a separate manifestation of the same repeated-copy pattern.
Repair direction: Allocate each bucket once and push in place, then keep subsequent processing linear or n log n. Add input-size/operation-budget tests and move expensive parsing off the main event loop where appropriate. Do not rely only on a multi-megabyte byte cap.
Required regression test: Benchmark 4k, 8k, 16k, and 32k inline spans and common-basename note sets. Assert a reasonable scaling ratio and bounded latency rather than a hardware-specific exact duration.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Actual SHA-verified code was benchmarked. Inline-code measurements were 39/433/2883/13954 ms for 16/32/64/128 KB. buildNoteIndex was also measured at 4k/8k/16k notes (23/70/524 ms).
Qualification: Times are from this container on Node v22.16.0, not a benchmark of the supported production runtime or a live server. The copying complexity is independent of that exact timing.
S2-022: A successful move response does not identify backlink rewrites skipped for conflict
Priority: P3
Historical evidence: S
Classification: new partial-completion reporting gap
Source: apps/server/src/knowledge/vault.ts; applyMoveItem; finishMove; moveNote
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Trigger: A backlink note changes externally after the rewrite plan is prepared, so the safe rewrite check correctly detects a conflict.
Mechanism: finishMove marks the item skipped and done, logs a warning on the server, and continues. The successful return contains only the destination path and a count of updated notes, not the skipped paths or a partial-completion status.
Impact: Content preservation is improved, but a user requesting link updates is not told which links remain broken or need repair. A numeric update count alone does not distinguish no affected links from skipped conflicted links.
Repair direction: Return explicit partial-completion information, including the skipped paths and reasons, and surface it in the move UI. Preserve the conservative refusal to overwrite concurrent edits.
Required regression test: Cause one of several planned backlink writes to conflict. Require success/partial status to list that exact skipped note while reporting the rewrites that did complete.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Source-traced API result and conflict branch. UI handling of a proposed response shape was not implemented or tested.
S2-023: The bounded media scrub never advances beyond a retained prefix of the store
Priority: P3
Historical evidence: S
Classification: new integrity-maintenance gap
Source: apps/server/src/media/store.ts; SWEEP_HASH_BUDGET_BYTES; sweep
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/media/store.ts
Trigger: The media store contains more than the 256 MiB per-sweep hash budget and its early rows remain retained across sweeps.
Mechanism: Every sweep starts a fresh budget and iterates the same SELECT order without a cursor or last-verified ordering. The same early rows consume the budget repeatedly, so some later rows may never have their integrity checked by maintenance.
Impact: Background integrity coverage can be permanently incomplete even inside the default 512 MiB store quota. Latent damage in the unvisited portion is not found until it is read or the earlier rows disappear.
Repair direction: Persist or retain a rolling verification cursor, or order by last verification time. Deduplicate shared physical hashes when budgeting work and ensure every retained blob eventually receives a turn.
Required regression test: Create retained rows totaling more than two scrub budgets, introduce same-size damage in a later row, and run multiple sweeps. Require eventual detection without deleting the earlier rows.
Historical verification note from the saved audit; supporting scripts/logs not recovered: The budget/iteration behavior was exercised in a scaled logic check, not with hundreds of megabytes of media.
Qualification: Media reads now verify hashes. This does not resurrect the previous claim that ordinary reads serve same-length corruption unchecked.
S2-024: The password setter is not atomic against the host password command
Priority: P2
Historical evidence: R
Classification: residual cross-process race
Related first-pass findings: SCORE-007
Source: apps/server/src/auth/security-password.ts; set; writePasswordFile
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/auth/security-password.ts
Source: scripts/set-password.mjs; credential/provenance publication
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/scripts/set-password.mjs
Trigger: The browser setter passes its final stored-hash comparison, then the separate host command resets the password before the browser publishes its replacement.
Mechanism: Removing awaits between comparison and write excludes competing JavaScript tasks in one event loop, not another operating-system process. There is no shared lock with the host command. The browser can overwrite the successfully reset host credential and replace its provenance with browser.
Impact: Both callers can believe their password change succeeded, but the host reset no longer works. The host-issued terminal enrollment marker can also cease to match the effective credential.
Repair direction: Use a shared inter-process lock and consistent credential/provenance publication protocol in both writers. Revalidate under that lock and define recovery for an interrupted multi-file credential update.
Required regression test: Run real separate writer processes synchronized after the browser comparison but before its rename. Require one update to reject/retry rather than two successful conflicting publications. Verify credential and provenance consistency.
Historical verification note from the saved audit; supporting scripts/logs not recovered: password-reproductions.mjs executed the SHA-verified SecurityPassword module with real scrypt and filesystem calls. A second Node process performed the host writer publication. Both writes succeeded; only the browser password remained valid.
Qualification: Zod and HttpError imports were replaced by narrow valid-input test doubles. This requires an authorized browser change racing an actual host reset; it is not an unauthenticated reset exploit.
S2-025: Reloading the bridge in a live gateway strands the retired sender outbox
Priority: P2
Historical evidence: S
Classification: residual
Related first-pass findings: SCORE-022
Source: hermes-plugin/score_bridge/__init__.py; register; unload
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/hermes-plugin/score_bridge/__init__.py
Source: hermes-plugin/score_bridge/spool.py; recoverable; process_start
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/hermes-plugin/score_bridge/spool.py
Source: hermes-plugin/score_bridge/sender.py; Sender initialization; shutdown
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/hermes-plugin/score_bridge/sender.py
Trigger: A bridge sender has persisted unsent records, then the plugin is re-registered/reloaded without terminating the hosting gateway process.
Mechanism: Registration shuts down the old sender and creates a new incarnation. The old spool still names the same PID and process-start identity as the live gateway. recoverable uses process liveness/identity, not sender incarnation liveness, and therefore treats that retired sender as alive.
Impact: Its unsent history can remain excluded from recovery until the gateway process itself exits. The PID-reuse fix correctly distinguishes different processes, but not old and new producers inside one process.
Repair direction: Record sender retirement, use per-incarnation ownership/leases, or explicitly hand old spools to the replacement sender after shutdown. Do not equate a live hosting process with every producer it previously hosted.
Required regression test: Persist an outbox while offline, call plugin registration again in the same process, restore transport, and require the replacement sender to drain the old incarnation before the host exits.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Source-traced reload and recovery paths. No live Hermes plugin reload was performed.
S2-026: In-flight hold recovery is still outside the shutdown join
Priority: P2
Historical evidence: C
Classification: residual conditional lifecycle risk
Related first-pass findings: SCORE-033
Source: apps/server/src/start-server.ts; recoverHolds registration; closeResources; track
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/start-server.ts
Source: apps/server/src/retry-until-resolved.ts; run; stop
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/retry-until-resolved.ts
Source: apps/server/src/http/task-holds.ts; applyOne; releaseOne; recover
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/http/task-holds.ts
Trigger: Shutdown overlaps an already running hold-recovery attempt that is awaiting a slow adapter operation.
Mechanism: The generic job tracker covers several samplers and sweeps, but recoverHolds is passed directly to retryUntilResolved. That helper discards the active promise; stop only prevents another timer. Hold recovery resumes with database reads and ingestion after adapter awaits, without a shutdown join owned by this helper.
Impact: Depending on adapter timing and other shutdown waits, work can resume after dependent resources have begun closing. The general sampler/listener fix does not establish a complete barrier for this path.
Repair direction: Give retryUntilResolved an awaitable close/drain operation or register each invocation in the server job tracker. Stop future admission, await active recovery, and only then close its dependencies.
Required regression test: Delay port.getTask or taskAction during startup recovery, begin shutdown, and release the delay. Assert no work touches a closed database and no recovery writes occur after the declared shutdown barrier.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Conditional source-level lifecycle analysis. The complete delayed-adapter shutdown scenario was not executed.
Qualification: Actual failure depends on adapter cancellation/draining behavior and timing. Keep this distinct from a demonstrated production use-after-close.
S2-027: The new move plan is not durably ordered before filesystem mutation
Priority: P2
Historical evidence: C
Classification: residual power-loss durability risk
Related first-pass findings: SCORE-034
Source: apps/server/src/knowledge/vault.ts; savePlan; moveNote; finishMove; clearPlan
Pinned source: https://github.com/kohz87/score/blob/9de8cd533963b78b9dd4d2bde850fb49d0cfa3e0/apps/server/src/knowledge/vault.ts
Trigger: Power loss or a storage failure occurs around saving the move plan/progress and publishing the file move or rewrites.
Mechanism: savePlan uses writeFile and rename but does not fsync the plan file or its containing directory before the caller proceeds with filesystem mutations. Awaiting those calls establishes completion to the process, not the stronger durability ordering needed for a roll-forward journal.
Impact: On affected storage/filesystems, a move or rewrite may survive while its plan/progress does not, weakening the new recovery guarantee. Ordinary process-interruption recovery is a real improvement, but it is a different guarantee from power-loss durability.
Repair direction: Durably publish the plan before any irreversible namespace mutation and durably record progress in the intended order. Fsync the file and parent directory where supported; define and disclose behavior where the platform cannot offer the required guarantee.
Required regression test: Use a filesystem fault harness or controlled crash/power-loss simulation around plan writes, renames, progress updates, and clearing. Verify that recovery either has enough evidence to converge or reports an explicit recoverable conflict.
Historical verification note from the saved audit; supporting scripts/logs not recovered: Conditional source-level durability analysis. No power-cut or filesystem crash experiment was executed.
Qualification: This is not a claim that every process crash loses the plan, nor that rename itself lacks atomic namespace semantics.
Saved recheck of the original 34 findings
The following assessments are reproduced from the saved second-pass artifact. They were not all independently re-audited during recovery.
Original ID    Saved assessment    Detail
SCORE-001    source-addressed    Incoming hashes and shared references are checked before unlinking; the original eviction sequence is addressed.
SCORE-002    partial    Main path improved; unsupported-link fallback still replaces an appearing target. See S2-002 and adjacent S2-003.
SCORE-003    source-addressed    Rewrite items now carry base hashes and use preconditions; skipped conflicts need better reporting (S2-022).
SCORE-004    source-addressed    Workspace uses a parked source identity instead of the old unconditional link/unlink sequence. Knowledge introduced a similar problem separately (S2-001).
SCORE-005    source-addressed    Recursive protection now uses the shared case-insensitive predicate.
SCORE-006    source-addressed    Only the parent segment and its separator-qualified prefix are treated as traversal.
SCORE-007    partial    Same-event-loop setters are fenced by a final hash comparison; a host process still races publication (S2-024).
SCORE-008    source-addressed    Successful verification rereads the stored credential after hashing.
SCORE-009    source-addressed    Only ENOENT is bootstrap absence; damage/read errors fail closed.
SCORE-010    source-addressed    The browser writer uses a unique temporary name and cleanup.
SCORE-011    source-addressed    New registration requires discoverability. Legacy descriptors are offered to paired browsers only; old non-discoverable credentials still need re-enrollment for public sign-in.
SCORE-012    source-addressed    The fence is recorded before the no-observer early return.
SCORE-013    source-addressed    Cacheless failed entries qualify for retry/reconnect recovery.
SCORE-014    source-addressed    Every buffering state is bounded and overflow fences the entry.
SCORE-015    partial    Logical cancellation and follow-up scheduling improved, but concrete fetchers ignore the signal (S2-012).
SCORE-016    source-addressed    Evicted handles forward their accessors as well as subscriptions.
SCORE-017    source-addressed    Fingerprint/ownership cache updates are staged until ingestion commits.
SCORE-018    source-addressed    Watcher-triggered verification and rotating full verification address metadata-only shortcuts.
SCORE-019    partial    Directory-level coverage fixed, but individual stat failures are still unverified absence (S2-015).
SCORE-020    source-addressed    The note read/index response construction is serialized.
SCORE-021    partial    Simple fences/escapes improved; nested list/blockquote code still rewrites (S2-020), and the rewrite introduced a CPU scaling problem (S2-021).
SCORE-022    partial    PID reuse is checked using process identity; retired senders in a still-live process remain stranded (S2-025).
SCORE-023    source-addressed    Unchanged outboxes are cached/skipped instead of all being rewritten per append.
SCORE-024    source-addressed    Ordinary MCP tools now hold permits through tracked tool completion, not just response closure.
SCORE-025    source-addressed    ZIP classification requires a full ZIP signature rather than two bytes.
SCORE-026    source-addressed    EOCD candidates are checked against archive end/directory bounds and invalid candidates are skipped.
SCORE-027    source-addressed    Filename truncation now preserves Unicode code points.
SCORE-028    source-addressed    NUL checks cover the full bounded text buffer.
SCORE-029    source-addressed    The opened descriptor and incremental read enforce maxBytes.
SCORE-030    source-addressed    Local mode now registers a Host allowlist.
SCORE-031    source-addressed    Directory synchronization was added around spool publication/removal.
SCORE-032    source-addressed    Reads verify the stored hash; the new scrub has a separate fairness issue (S2-023).
SCORE-033    partial    Samplers and committed listeners are joined, but active hold recovery remains outside the barrier (S2-026).
SCORE-034    partial    A plan exists and supports ordinary replay; recovery convergence and power-loss ordering still require work (S2-014 and S2-027).


Closure criteria
For each repair, add a regression that reaches the actual application boundary implicated by the finding, verify that it fails on the affected revision and passes with the fix, and run the repository checks on the supported runtime. Do not close a cross-process, cancellation, or durability finding on the basis of a simplified single-threaded unit test alone.
Keep fixes on reviewable branches. Do not use a live agent or paid model merely to test admission, stopping, or result delivery; deterministic fake runtimes and harmless child processes are sufficient for those boundaries.
