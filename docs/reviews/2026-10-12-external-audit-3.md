# Score: third-pass audit report
Repository: kohz87/score
Code revision: e43f5e82e62c5237c94e9c68bfc7d4bdef47e47e
Changelog release: 1.0.2
Date: 12 October 2026
Mode: Read-only repository inspection; isolated tests in temporary container files only.
Executive result
This report contains six actionable findings: one P1 and five P2. One finding was reproduced in two deterministic filesystem interleavings; the other five are source-traced. Four isolated checks were executed in total: the two new failure variants and two checks showing that earlier scenarios are now handled correctly.
This is a scoped third-pass report, not a completed full-repository audit. The earlier unfinished pass used 7773102a...; main now resolves to the revision above, so the findings below were checked against that newer code. It would be inaccurate to claim that every module or all previous findings have been re-audited.
The priority is to fix the destination-identity race in the move helper. The remaining issues concern preserving recovery evidence, proving the identity of a recovered move, retaining terminal-result delivery, retrying process-member persistence, and recovering missed live-state updates.
Evidence labels
R: Actual selected source-module logic executed in isolation, with the specific substitutions disclosed.
S: A concrete failure path traced in current source. The full application trigger has not been run.
P1 means credible direct data loss requiring prompt attention. P2 means a material correctness, persistence, or recovery defect with its stated prerequisites. These priorities are engineering triage, not formal vulnerability scores.
What ran
tests/moves.mjs transpiles the source in source/move-file.ts without changing its operational logic. The source bytes were verified against GitHub blob SHA db90636da7fde2ee3d9015a1a3bfdf7527b15f8a. The HttpError import is replaced by a test double preserving the fields used by the helper and assertions. Filesystem wrappers insert controlled replacements while the actual link, rename, unlink, stat, and directory-sync operations use real temporary files.
Runtime: Node v22.16.0. This is not production-runtime certification. No live Hermes process, coding-model invocation, user data, or repository mutation was involved.
Check
Observed result
Replace destination before its post-link identity read
Conflict returned, but concurrent destination content was deleted.
Replace destination after identity read, before source removal
Move returned success; original content no longer had a file in the fixture.
Replace source after linking, the older S2-001 scenario
Conflict returned; the newer source was preserved.
Hard links unsupported, the older S2-002 fallback scenario
Operation refused; source remained unchanged and no destination was created.
The first two rows are one defect with two manifestations, not two independent findings. Logs are in move-results.json; the tests clean up their temporary directories.
Findings
S3-001 | P1 | R | A concurrent destination replacement defeats the repaired no-replace move
Classification: Newly identified race in the replacement helper.
Locations:
apps/server/src/knowledge/move-file.ts: moveNoReplace, removeOldName.
apps/server/src/knowledge/vault.ts: moveNote.
Trigger: Another writer replaces the destination after the helper creates its hard link, either before or after the following destination lstat.
Why it happens: The helper obtains the linked identity by reading the public destination pathname after awaiting fs.link. That pathname may already identify somebody else's file. If replacement happens before lstat, cleanup mistakes the replacement for the linked object and removes it. If replacement happens after lstat but before source removal, the helper can remove the final name of the original source and return success with only the unrelated destination remaining.
Impact: Two demonstrated outcomes: a 409 conflict deletes the concurrent destination edit, or a successful return loses the original source content. These are two variants of one destination-identity race, counted once.
Repair direction: Use a platform-supported atomic no-replace rename for a true move. Do not establish ownership from a pathname after it became externally writable. If only a staged multi-operation protocol is available, retain protected source evidence and a recovery record, refuse uncertain completion, and preserve conflicting objects. Adding another check before unlink is not an atomic guarantee.
Required regression: Keep both deterministic interleavings in tests/moves.mjs. For the before-lstat variant, the concurrent destination content must survive. For the after-lstat variant, the original must not disappear while the operation claims success. Also keep the two positive regressions for a replaced source and unsupported hard links.
Verification: Executed the transpiled, Git-blob-SHA-verified move-file.ts logic against real temporary files. Only the HttpError import was replaced by a narrow test double. Filesystem method wrappers injected the ordering; this was not an independently running editor or a Fastify route test.
Qualification: Requires a concurrent destination writer. Uncontended moves are not claimed to fail. The two earlier scenarios tested here are now handled correctly.
Relationship to earlier reports: S2-001: source replacement now passes the isolated preservation check; S2-002: unsupported-link fallback now refuses safely.
S3-002 | P2 | S | Move recovery deletes its recovery record on retryable errors
Classification: Residual recovery problem; startup no longer wedges, but progress can be discarded.
Locations:
apps/server/src/knowledge/vault.ts: moveNote, recoverMove, recoverMoveUnsafe, finishMove, clearPlan.
Trigger: A move encounters an error after it has changed files, or replay of an interrupted move hits a transient filesystem/database/commit/index failure.
Why it happens: The live move catch clears the plan for every move-helper failure, without proving that no mutation occurred. recoverMove also catches every recovery failure and clears the plan. finishMove deliberately throws move_incomplete while preserving an unfinished plan, but when that happens during replay its outer wrapper removes the same plan.
Impact: The application can start normally while permanently abandoning pending backlink rewrites or losing the recorded parked-file location. Correcting the temporary error and restarting again no longer retries the discarded operation.
Repair direction: Separate malformed plans, confirmed cancellation, permanent conflicts, and transient operational failures. Keep recoverable plans and progress, expose a pending/conflicted state, and retry without making global Knowledge startup fail. Clear an operation only after successful completion, explicit abandonment, or evidence that no mutation happened.
Required regression: Interrupt a move, fail the next recovery write once with EIO or EACCES, then recover the dependency and restart again. Require the operation record to remain and converge. Also fail directory sync after the helper has moved the file and verify that the plan is not unconditionally discarded.
Verification: Source-traced error and cleanup paths at the pinned commit. No full Knowledge restart fault-injection test was executed.
Qualification: This concerns retryable failures, not a requirement to retry irreparably corrupt plans forever. File bytes are not necessarily lost; operation intent and automatic recovery are lost.
Relationship to earlier reports: S2-014; S2-027: fsync ordering is improved, but durable records must also survive retryable failures.
S3-003 | P2 | S | Recovery can treat an unrelated destination as proof that a move completed
Classification: Newly identified interrupted-operation identity gap.
Locations:
apps/server/src/knowledge/vault.ts: moveNote movePlan construction, recoverMoveUnsafe.
Trigger: The move plan is saved and the process stops before the move. While it is down, an external operation removes or relocates the source and creates an unrelated file at the planned destination.
Why it happens: The created plan records paths, author, parked path, and backlink rewrite contents, but no identifying source content/inode evidence for the move itself. Recovery compares identities only when both source and target exist. With source absent and target present, it proceeds directly to the move commit and finishMove.
Impact: Recovery can announce a move that never occurred and rewrite valid backlinks to an unrelated destination. The base-hash checks on backlink notes do not establish that the destination is the intended moved note.
Repair direction: Record enough durable source/publication identity and operation phase to distinguish successful publication from unrelated pathname changes. Require matching evidence before rewriting links. Preserve uncertainty as a recoverable conflict instead of interpreting destination existence as success.
Required regression: Save a plan before publication, stop, move the source externally to a different name, create an unrelated target, then recover. Require no false moved event and no backlink rewrites to the unrelated file.
Verification: Source-traced plan construction and the source-absent/target-present recovery branch. No full crash/restart experiment was run.
Qualification: Requires an interrupted move plus independent external file changes while the application is down. It is not claimed for ordinary uninterrupted moves.
S3-004 | P2 | S | Terminal-result persistence can still be abandoned after the retry budget
Classification: Residual of S2-008.
Locations:
apps/server/src/runtimes/coding/service.ts: finish, startRun queue cleanup, execute.
Trigger: The CLI has finished, but terminal-result ingestion fails throughout all five normal attempts and the final degraded-result attempt.
Why it happens: finish adds bounded retries, then tries a different degraded observation. The final rejection is caught and sent only to onError. With the ordinary nonthrowing error reporter, the returned promise resolves and the queue cleanup removes the active entry. This path has no retained terminal-result delivery record that is retried once persistence recovers.
Impact: The finished run can remain queued/running or its reply streaming despite the live execution entry being gone. Depending on which terminal writes failed, a process record can also remain unreleased. Restart recovery may mark interruption, but it does not recover the exact completed result from this discarded delivery state.
Repair direction: Separate process completion from successful result persistence. Retain the final outcome in a retryable delivery state until it is committed, expose degraded persistence, and reconcile safely without launching the model again. Retain ownership evidence consistently with the eventual terminal commit.
Required regression: Fail all normal and degraded terminal writes, let the agent process finish, then restore ingestion without restarting the CLI. Require the same result to be persisted and the streaming reply and ownership record to converge.
Verification: Source-traced finish retry loop, final catch, and active-entry deletion. No database outage integration run was executed.
Qualification: A brief transient failure within the new retry budget is now handled better. The reported failure specifically exceeds that budget; it does not negate the retry improvement.
Relationship to earlier reports: S2-008.
S3-005 | P2 | S | Failed process-member recording is marked as already recorded and never retried
Classification: Newly identified supervision bookkeeping defect.
Locations:
apps/server/src/runtimes/coding/process.ts: noteMembers, noted.
apps/server/src/runtimes/coding/service.ts: recordMembers, membersOf, stopGroup.
apps/server/src/runtimes/coding/proc.ts: inspect, killRecordedGroup.
Trigger: A scan finds a child-group member, its database recording callback fails, and the same member remains alive through later scans. Score subsequently restarts after the leader has exited.
Why it happens: noteMembers adds pid:startTime to the noted set while building fresh, before invoking onMembers. A callback exception is swallowed, but those entries are not removed. Subsequent scans filter the same identities out, including forced exit-time scans. Recovery uses persisted identities to establish ownership of a leaderless group.
Impact: One temporary bookkeeping failure can permanently prevent this supervisor from persisting otherwise repeatedly observable member identity. Later recovery can classify the owned survivor as unobservable, decline to signal it, and block new work until manual resolution or natural termination.
Repair direction: Only acknowledge identities in noted after successful recording. On failure, leave them eligible for retry. Use idempotent inserts or a transaction to tolerate partial batches, and report persistent recording degradation without claiming the processes disappeared.
Required regression: Make the first onMembers call throw, return the same member on the next scans, and require another persistence attempt. Then restart with a missing leader and the surviving recorded worker, and verify correct ownership recovery.
Verification: Source-traced ordering and recovery dependency across all three modules. The child-process/restart scenario was not executed.
Qualification: The failure is missing durable identity, not proof that current Stop immediately fails. The live group supervisor can still act before the restart.
S3-006 | P2 | S | Reopening an idle cached query after a failed refresh can silently preserve missed changes
Classification: Newly identified same-epoch gap adjacent to the earlier reset fixes.
Locations:
apps/web/src/data/resync.ts: entry.event, subscribe, refetch, recover, flush.
Trigger: A query becomes unobserved while its cache remains. Relevant updates arrive during that idle interval, then the query is reopened and its ordinary snapshot request fails. The stream stays in the same epoch.
Why it happens: entry.event discards events when observers is zero. Re-subscription calls refetch without a fence. With a previous cache and no fence, the failure path keeps the old snapshot; retry/reconnect recovery only covers fenced or cacheless entries. A later relevant event can be reduced onto that stale snapshot and publish success, advancing asOfSeq without repairing the missed update.
Impact: The UI can show a successful live state with stale records from the idle interval. The old values can persist until another successful full snapshot or another update of those specific records occurs.
Repair direction: Track idle-period invalidation independently of epoch changes. Mark the entry as needing an authoritative snapshot when it becomes idle or misses a relevant event, and do not resume successful delta application until that snapshot succeeds. Alternatively, continue reducing into retained idle caches under a bounded policy.
Required regression: Cache A at sequence 10, unsubscribe, emit an update to A at 11, resubscribe with a failed fetch, then emit an unrelated item B at 12. Require a fenced/retrying state rather than successful data containing old A with asOfSeq 12. Repeat without a reconnect or epoch change.
Verification: Source-traced registry transitions. No TanStack/React integration test was executed.
Qualification: The old idle-epoch-reset fix is present. This case occurs in the same epoch and relies on a retained cache plus a failed refresh.
Relationship to earlier reports: Adjacent to SCORE-012 and SCORE-013; not a claim that their original branches are unchanged.
Earlier fixes actually checked in this pass
Do not interpret the new findings as a claim that the update accomplished nothing.
Earlier finding
Current check
Confidence
S2-001, newer source deleted during move
The controlled source-replacement case now preserves the new source and returns conflict.
Executed helper-level check.
S2-002, unsafe fallback on unsupported links
The helper now refuses rather than falling back to replacing rename.
Executed helper-level check.
S2-004, onSpawn failure before supervision
Supervision is installed before onSpawn; its failure starts termination and exposes a termination promise.
Source inspected; not executed here.
S2-005, Stop ignored after leader exit
Stop no longer automatically returns on a recorded leader exit; exit initiates group reaping.
Source inspected; full process matrix not run.
S2-006, requested coding model ignored
The admitted model is passed into execute and driver.buildArgs.
Source inspected.
S2-007, Stop during preflight still launches
Cancellation is checked again after the running observation and before spawn setup.
Source inspected.
S2-022, skipped backlink rewrites hidden
The move result includes skipped paths and reasons.
Source inspected.
S2-027, plan publication not durably ordered
Plan file sync and containing-directory sync are now present before proceeding.
Source inspected; not a power-loss test.
This table is intentionally limited. It is not an assertion that every previous fix passed its regression suite. S3-004 explains the remaining terminal-persistence case; S3-001 and S3-002 explain why safe move behavior and durable plan writes alone do not complete the recovery guarantee.
Repair batches
Batch A: no-replace move ownership and recovery
Address S3-001 first. The public destination cannot serve as immutable ownership evidence during a multi-step move. Keep both failure variants and the two positive checks as regressions.
Then address S3-002 and S3-003 together. Recovery needs both durable intent that survives retryable failures and evidence that the intended object was published. Neither a surviving pathname nor a generic catch-and-delete recovery policy establishes that.
Batch B: terminal outcomes and process bookkeeping
Address S3-004 and S3-005. Separate what the operating system did from what the database successfully recorded. An acknowledged terminal result or member identity must correspond to a successful persistence operation. Retry safely without launching a second CLI/model run to recreate the first result.
Batch C: live snapshot validity
Address S3-006. A fresh stream connection is not the only way a query misses events; inactive registrations do so by design. Snapshot validity must cover the inactive interval, and a failed refresh must not be disguised by a later successful delta.
Coverage and limitations
Freshly inspected: the changelog, the complete move helper, selected Knowledge move planning/recovery/finalization paths, the complete coding process and process-recovery helpers, selected runtime admission/execution/completion/reaping paths, and the live-query registry lifecycle.
Not completed: a whole-repository traversal, verification of every earlier finding, the full workflow/orchestration matrix, the remaining authentication/bridge/media/sharing/deployment surfaces, dependency checks, or the repository's build/typecheck/unit/integration/end-to-end suites. No production load, browser integration, restart outage, or power-loss suite was run.
The five source-traced entries must receive their listed regression tests before being treated as experimentally demonstrated full-application incidents. The isolated move result is stronger evidence for its helper, not proof of every caller's complete end-to-end behavior.
Files in this bundle
report.md: this report.
findings.json: structured issue catalog and explicit coverage metadata.
move-results.json: actual outputs of the four isolated checks.
source/move-file.ts: the verified original helper at the pinned revision.
tests/moves.mjs: executable test harness.
tests/error-stub.mjs: the disclosed error-class test double.
tests/move-file.mjs: transpiled helper produced by the harness.
README.md: how to run the isolated checks.
