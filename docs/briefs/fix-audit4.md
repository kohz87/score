# Fix batches for external audit 4 (v1.3.1)

Findings: `docs/reviews/2026-10-15-external-audit-4.md` (all checked against the code by the lead). Four builders in
parallel, separate worktrees/branches, pre-assigned migrations and e2e ports; merged one at a time by the lead.

Rules for every batch: AGENTS.md (licensing, no new dependencies, contract doc first), the builder brief rules (no
pkill/killall or pattern kills; never touch 8740/8741 or the live Score; no git stash — patch/checkout/apply; no
`SCORE_E2E_DEV=1`; no `pgrep -f` or any background wait-loops; clean up every process), **failing-first tests against
the real modules** (run each against the old code and say so), `pnpm check` green (known load flakes may be rerun
alone), full e2e on the batch's port, commits "audit4-<batch> #n: …", `git add <paths>` only, don't merge.

## Batch A (`task/audit4-a`, e2e port 5491, migration 0069 if needed) — S4-001 + S4-007
1. **S4-001:** the last-observer cleanup in `resync.ts` must not discard buffered events without fencing: when the
   last observer leaves while a snapshot is in flight or `buffer` is non-empty, mark a cached query untrusted
   (`fenced = true`, as the idle-event path does); only a successful authoritative snapshot clears it. Regression: hold a
   refresh, deliver update 11, unsubscribe, reopen with a failing fetch, deliver 12 ⇒ never `success` with the missed
   value; a later successful snapshot recovers. Keep the existing idle-event control test passing.
2. **S4-007:** an explicit retention contract for `coding:<agent>` ingest keys: once a coding run is terminal, its result
   delivered (no `coding_pending_terminals` row) and its launch settled (or no launch: Chat process-group runs), its
   detailed event keys can go — keep a bounded replay guard (e.g. the admission/terminal identities, or a per-run
   tombstone) so a replayed observation can't recreate effects. Reclaim in the regular retention job; pending and
   unsettled runs keep everything. No blanket TTL. Regression: complete runs ⇒ keys reclaimed and a replay of an old
   observation is still refused; a pending terminal and an unsettled launch keep their keys.

## Batch B (`task/audit4-b`, port 5492, no migration expected) — S4-002 + S4-003
1. **S4-002:** `migrateLegacyPlan` = copy, confirm the replacement is durably written (file + folder sync, re-read and
   parse), then delete the legacy file. Malformed legacy content (parse error) is the only case that may discard it
   (log it); any I/O error keeps the legacy file for the next start. When both files exist, keep the newer one per plan
   identity and only then remove the legacy one. Regression: inject failures at create/write/rename/dir-sync ⇒ a usable
   plan always remains; after I/O recovers the next start migrates exactly once.
2. **S4-003 (owner decision 80):** a note whose path is Git-ignored and untracked is saved but marked **not in history**:
   detect with `git check-ignore` (argv, `--no-index` where needed) before committing; the save response and the note's
   metadata carry `versioned: false` (contract doc first); the web shows a badge "Not kept in history" with the reason
   (".gitignore excludes this folder"), the History tab says why, and overwrite/delete of such a note warns that there
   is no earlier version. Never force-add. A tracked note that later matches an ignore rule keeps normal history. Commit
   failures for other reasons are still reported as "saved, history not updated" rather than swallowed silently
   (save result field + log). Regressions: newly ignored note, globally ignored (core.excludesFile) note, tracked note
   later matching a rule; web badge/warning tests.

## Batch C (`task/audit4-c`, port 5493, migration 0068) — S4-004
1. A share **owns** its images: a `share_media` table (share id, media id, unique pair); creating a share retains each
   distinct image once in the same transaction (the media reference mechanism used by messages); revocation, expiry
   cleanup and deletion release exactly once; eviction and unused-media cleanup never remove media a live share holds.
   Migration 0068 reconciles existing live shares (adds their rows and references). Regression: share an image, delete
   or rewind the original message, force eviction, fetch the shared image ⇒ still served until the share ends; two
   shares of one image; an image appearing twice in one snapshot; expiry releases it.

## Batch D (`task/audit4-d`, port 5494, no migration expected) — S4-005 + S4-006 + S4-C01
1. **S4-005:** keep a deadline until authentication succeeds or the socket closes (don't clear the hello timer before
   `hello()` decides); on rejection write the short reply, then `destroy()` (with a hard backstop timer); release the
   unauthenticated slot exactly once. Regression with real Unix-socket clients using `allowHalfOpen: true`: rejected
   unknown-launch, malformed, mismatched-token and replayed hellos ⇒ sockets and slots gone within a bounded time, then
   a valid supervisor connects.
2. **S4-006:** an idempotent `ensureListener()` shared by start and the user's "Check again": retries binding when no
   owned listener exists, clears `socketError` only after a confirmed bind, keeps installation-lock and foreign-listener
   protections, serialises concurrent rechecks. Regression: first start fails, second attempt succeeds via the real
   recheck path ⇒ a genuinely listening socket and a usable backend; concurrent rechecks; a foreign listener still
   blocks.
3. **S4-C01:** verify through the real callers (Chat dispatcher, executor, HTTP) whether two same-turn `startRun` calls
   can overlap; regardless, serialise admission per turn (in-process per-turn lock) and return the **persisted** run id
   (reread after awaits), never a speculative one. Regression: two concurrent same-turn calls ⇒ both get the same
   existing run id, one execution scheduled; with and without a pending intent. Report what you found about
   reachability.
