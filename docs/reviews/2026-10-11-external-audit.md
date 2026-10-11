# External application audit (received 2026-10-11)

Repository kohz87/score at 3349e79 (18 commits before v1.0.0; none of those touch the audited areas). Read-only source
review with isolated reproductions; 34 findings: 4 P1, 25 P2, 5 P3 (29 code-level, 5 conditional). Lead spot-checked
SCORE-001, 004, 005, 006, 027 in the source: confirmed. Fix batches: N (media/workspace), O (knowledge), P (auth/server
lifecycle), Q (web live state/bridge outbox). Evidence: R = isolated reproduction, S = source-traced, C = conditional.

## Code-level findings

**SCORE-001 | P1 | R | Media — Quota eviction can delete the blob belonging to a successful new upload.** `media/store.ts`
store(), evictFor(); `media/sniff.ts`. Metadata distinguishes (sha256, content_type) but files are named only by sha256.
Eviction decides an old hash is unreferenced before the incoming row is inserted; after insertion and the blob write,
cleanup unlinks the previously selected hash without rechecking. Trigger: upload text as data.txt, fill quota, upload the
same bytes as data.csv/.md. Impact: upload succeeds, row remains, reading fails (blob removed). Fix: decide physical deletion
after the transaction, recheck all current references; protect the incoming hash. Test: quotaBytes = one payload; store
identical bytes under two text extensions; second ID readable immediately and after sweep.

**SCORE-002 | P1 | R | Knowledge — A note move can silently overwrite a concurrently created destination.** `knowledge/vault.ts`
moveNote(), atomicWrite(). Destination absence is checked, then later an overwrite-capable fs.rename; the null-hash create
path in atomicWrite has the same check/rename gap. Fix: atomic no-replace publication (e.g. link+unlink-of-temp or
renameat2 RENAME_NOREPLACE equivalent; reuse Workspace.commit's no-clobber intent). Test: pause after destination lookup,
create destination externally, resume → conflict with both files preserved; same for null-etag create.

**SCORE-003 | P1 | R | Knowledge — Link rewriting during a note move can discard outside edits.** moveNote() builds rewritten
contents from earlier reads and later calls atomicWrite without an expected hash. Fix: capture a hash per planned file and
require it on apply; on conflict stop safely with a recoverable plan. Test: outside edit between plan and apply survives;
conflict or explicit recoverable partial result.

**SCORE-004 | P1 | R | Workspace — A file move can unlink a newer source replacement.** `workspace/workspace.ts` moveLocked():
link(source,target) then unlink(source) on the pathname. Fix: atomic no-replace rename where available; otherwise source
identity check (dev/ino) before unlink and crash recovery. Test: pause between link and unlink, atomically replace source
externally, resume → replacement not deleted.

**SCORE-005 | P2 | R | Workspace — Recursive deletion bypasses protection for case variants of .git.** policy.ts isGitName()
is case-insensitive; workspace.ts assertNothingProtected()/removeTree() test `child === '.git'`. Fix: one shared protected-name
predicate everywhere. Test: .git/.Git/.GIT identical protection for direct and parent-recursive delete.

**SCORE-006 | P2 | R | Workspace — Containment predicate misclassifies children named `..something`.** policy.ts isInside()
rejects any rel starting with "..". Fix: `rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)`. Test:
sibling traversal, equal path, normal descendant, real descendant `..backup` under every forbidden root.

**SCORE-007 | P2 | R | Auth — Concurrent password setters overwrite one another without revalidation.**
`auth/security-password.ts` set(): decide/verify, await hashing, write; no serialization or compare-and-swap. Fix: serialize and
compare the persisted credential generation before replacement (host CLI changes too). Test: barrier on both hashes; one
first-time setter wins, the other conflicts; same for two rotations.

**SCORE-008 | P2 | R | Auth — In-flight verification can succeed after a host reset.** verify() captures the hash before scrypt
and never re-reads. Fix: after deriving, verify the generation/hash is still current. Test: replace credential while hashing
is paused → reject.

**SCORE-009 | P2 | S | Auth — Corrupt or unreadable password storage is treated as uninitialized.** stored() returns undefined
for parse failures and all read errors; set() then skips current-password verification. Fix: only ENOENT (intentional bootstrap)
is unset; other failures = closed security-store error needing host recovery. Test: malformed, empty, EACCES vs ENOENT.

**SCORE-010 | P2 | R | Auth — A failed password-file replacement blocks later replacements.** writePasswordFile(): deterministic
per-PID temp with wx, no cleanup if rename fails. Fix: unique temp names, cleanup in finally. Test: inject one rename failure,
retry succeeds.

**SCORE-011 | P2 | S | Auth — Passkey enrollment accepts credentials login may not discover.** `auth/passkeys.ts`:
residentKey 'preferred' at registration; authentication omits allowCredentials. Fix: require discoverable credentials
(residentKey 'required', requireResidentKey) or pass stored descriptors. Test: enroll→login with a non-resident credential.

**SCORE-012 | P2 | R | Live state — An idle query can miss an epoch/reset fence and reuse an invalid snapshot.**
`web/src/data/resync.ts`: refetch(true) returns before marking fenced when there are no observers; reopening starts
refetch(false). Fix: record fence invalidation for idle registrations. Test: cache seq 100, unsubscribe, reset to new epoch,
resubscribe with failed fetch, deliver seq 1 → old snapshot not treated as valid.

**SCORE-013 | P2 | S | Live state — Initial snapshot failures are excluded from reconnect recovery.** Fix: explicit recovery
state for cacheless failures with bounded backoff or a deliberate manual-retry state. Test: first fetch fails after hello,
reconnect → retries or bounded manual state.

**SCORE-014 | P2 | S | Live state — Event-buffer cap not applied during ordinary unfenced loads.** entry.event() overflow check
only when fenced; apiFetch has no default deadline. Fix: bound memory in every buffering state; abortable snapshot deadline.
Test: unfenced fetch unresolved + > maxBuffered events → bounded + controlled recovery.

**SCORE-015 | P2 | S | Live state — Overflow recovery repeatedly supersedes slow snapshots without cancelling them.** Fix: one
snapshot request per entry, cancel superseded work (AbortSignal), coalesce overflow into one follow-up. Test: small maxBuffered,
deferred fetches, repeated overflow → bounded concurrency, eventual acceptance.

**SCORE-016 | P2 | R | Live state — An evicted query handle forwards subscriptions but keeps stale snapshot/refetch.** Fix:
forward the complete handle to the current entry (or invalidate stale handles). Test: retain handle across idle eviction,
resubscribe → snapshot updates and refetch work.

**SCORE-017 | P2 | R | Orchestration — In-memory fingerprint and ownership caches survive database rollback.**
`domain/orchestration/executor.ts` mutate()/finalize(); `hub/ingest.ts`. finalize updates fingerprints/ownershipSeen inside the
transaction. Fix: stage and publish after commit (or restore on failure). Test: inject failure after finalize, retry identical
projection → correct revision, event, ownership history.

**SCORE-018 | P2 | R | Knowledge — Timestamp-preserving same-size edits evade the scanner.** vault.ts scan() skips hashing when
mtime(ms) and size match. Fix: hash watcher-dirty paths; periodic content verification. Test: same size, same mtime, different
content → scanNow refreshes search/backlinks.

**SCORE-019 | P2 | S | Knowledge — An incomplete walk is treated as proof notes were deleted.** walk() swallows readdir failures;
scan() removes rows absent from the map. Fix: track coverage/failed subtrees; only infer deletions from fully enumerated
directories; report degradation. Test: EACCES on an indexed subtree → rows/links remain.

**SCORE-020 | P2 | S | Knowledge — A note response can mix content from one version with metadata from another.** readNote()
reads raw+hash before the queue; indexFile reads again. Fix: one coherent version under the lock, or re-read/validate. Test:
change between raw read and indexFile → body, etag, title, links, author from one version.

**SCORE-021 | P2 | R | Knowledge — Link rewriting can alter Markdown code examples and escaped literal links.**
`knowledge/links.ts` codeRanges/parseWikilinks/rewriteLinks. Fix: Markdown-aware tokenisation (indented code, longer outer fences,
inline code variants, escaped `\[[Target]]`). Test: those cases unchanged byte for byte.

**SCORE-022 | P2 | S | Bridge — Orphaned outboxes unrecovered while an unrelated/replacement producer uses the same PID.**
`hermes-plugin/score_bridge/spool.py` recoverable(); sender.py _recover_orphans(): os.kill(pid,0) as liveness. Fix: record process
start identity (boot id + /proc/<pid>/stat start time) and/or an active lease. Test: abandoned spool whose PID is a live unrelated
process is recovered.

**SCORE-023 | P2 | S | Bridge — Appending one batch rewrites and fsyncs unrelated outbox files.** _enforce_directory() rewrites
every healthy file on each append under a global lock. Fix: track sizes/changed files; rewrite only what needs repair/eviction.
Test: N unchanged outboxes, append to one → unchanged files not rewritten (count reads/writes/fsyncs).

**SCORE-024 | P2 | R | MCP — Disconnecting clients free concurrency slots before their tools finish.** `mcp/routes.ts` release on
response close; tools have no abort. Fix: release permits on task completion (or cooperative cancellation then release).
Test: barrier-held tools, close responses, more calls → active work never exceeds the cap.

**SCORE-025 | P3 | R | Media — Plain text beginning with "PK" rejected as a malformed archive.** sniff.ts. Fix: require a full
ZIP signature (PK\x03\x04 / \x05\x06 / \x07\x08) and fall back to text validation. Test: "PK report" under each text extension.

**SCORE-026 | P3 | R | Media — ZIP EOCD signature inside a legal archive comment breaks Office detection.** zipEntryNames(): last
EOCD match not validated. Fix: validate candidates (comment length reaches archive end, coherent directory range), keep
scanning. Test: valid DOCX/XLSX with a comment containing a false EOCD.

**SCORE-027 | P3 | R | Media — A valid Unicode download filename can cause an internal error.** http/media.ts attachment():
slice(0,120) on UTF-16 then encodeURIComponent. Fix: truncate by code points / byte budget. Test: 119 ASCII + emoji.

**SCORE-028 | P3 | R | Workspace — Binary detection and text-write validation disagree about NUL after 8 KiB.** decodeText()
checks the first 8192 bytes; write() rejects NUL anywhere. Fix: same full-content policy on read and write. Test: NUL at 9000.

**SCORE-029 | P2 | S | Knowledge — Note-size limit bypassable by growth between stat and read.** readContainedBuffer() uses
handle.readFile without a bound. Fix: check the opened descriptor and bounded read refusing growth beyond the limit. Test: swap
small→oversized between stat and open; grow during read → reject without full allocation.

## Conditional risks

**SCORE-030 | P2 | C | Security — Local browser API reads lack the Host validation used on the MCP listener.** auth/remote.ts
local-mode early return; csrf mutations-only; read routes. Fix: strict local Host allowlist (127.0.0.1, localhost, [::1] with the
configured port) on all routes incl. GET in local mode. Test: requests with a foreign Host are rejected.

**SCORE-031 | P2 | C | Durability — Outbox does not fsync directory changes after rename or unlink.** spool.py _write(),
acknowledge(), quarantine(). Fix: fsync the parent directory after os.replace and unlink. Test: unit test that the directory fd is
fsynced (mock) — power-loss not testable here.

**SCORE-032 | P3 | C | Integrity — Same-length media corruption served under the original hash.** media store read() checks size
only. Fix: verify sha256 on read for small blobs (bounded) and in a periodic bounded sweep; mark corrupt media. Test: same-length
replacement detected.

**SCORE-033 | P2 | C | Lifecycle — Shutdown has no complete barrier for asynchronous observers and samplers.**
start-server.ts closeResources()/sampleSpend(); hub/ingest.ts close()/flushListeners(). Fix: track outstanding jobs, stop new work,
drain in dependency order, close SQLite last. Test: sampler and listener held at an await during shutdown → nothing touches closed
resources.

**SCORE-034 | P2 | C | Recovery — A failed multi-file note move has no durable roll-forward plan.** Fix: persist move plan and
per-file progress (resumable), or staged apply with rollback; never lose unrelated edits. Test: fail the second backlink write,
restart → resumed or reverted cleanly.

## Not promoted by the auditor (for targeted testing later)
Partial acknowledgement end to end; listener/backoff-map growth; startup requests racing recovery; snapshot request-key reuse
across an evicted registration; interruption of a destructive index rebuild; full workflow dispatch/cancellation matrix.
