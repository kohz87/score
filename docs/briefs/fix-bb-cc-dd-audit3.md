# Fix batches BB, CC, DD: third external audit (6 findings on 1.0.2)

Source: `docs/reviews/2026-10-12-external-audit-3.md` (verbatim). Read your findings in full. Shared rules as
`docs/briefs/fix-rstuv-audit2.md` ("Rules for every batch"): failing-first tests at the real boundary, **no git stash**
(save a patch, `git checkout -- <files>`, test, `git apply`), no pkill/killall, never touch 8740/8741 or the real
`~/.score` / `~/.local/state/score`, nothing left running, don't merge.

## BB — Knowledge moves (S3-001 P1, S3-002, S3-003); e2e port 5480
- **S3-001: an atomic no-replace rename.** Replace the link/lstat/park/unlink protocol in
  `apps/server/src/knowledge/move-file.ts` with Linux `renameat2(..., RENAME_NOREPLACE)`, called through a tiny helper
  `knowledge/rename-noreplace.py` (stdlib `ctypes`, `python3 -I`, argv only; exit 0 moved, 17 EEXIST, 2 ENOENT,
  22/95 unsupported, 5 other) and a `.ts` wrapper with a cached probe (same pattern as
  `runtimes/coding/pidfd-signal.{py,ts}`). One kernel call: the destination is never replaced and nothing is ever unlinked.
  EEXIST ⇒ 409; ENOENT ⇒ 404; unsupported filesystem or no python ⇒ refuse with a plain message (no fallback). Use it
  for notes, documents and new-note publication (temp → final), and for the workspace move if it is a clean swap (else
  report). Remove the now-unused parking code and its plan fields only where nothing else depends on them.
  Regression: both audit interleavings (destination replaced before/after any read) can't happen any more — test that a
  concurrent destination makes the move fail with 409 and both files survive byte for byte; source replaced before the
  rename moves the newer file (correct); unsupported ⇒ refused, nothing changed.
- **S3-002: recovery keeps its plan unless it is finished, abandoned or proven untouched.** Classify failures:
  malformed plan ⇒ quarantine the plan file (rename to `.bad`, report) and start; permanent conflict ⇒ record skipped
  items, finish the rest; transient (EIO, EACCES, EBUSY, ENOSPC, DB/commit/index errors) ⇒ **keep** the plan, mark
  Knowledge "move pending" (visible on the Knowledge page), retry with backoff, never fail global startup. The live
  `moveNote` catch clears the plan only when the rename itself failed (nothing moved). Regression per the audit.
- **S3-003: recovery needs proof the destination is the moved file.** Record the source's identity in the plan before
  the move (content hash + size, and dev/ino); recovery treats "source absent, target present" as a completed move only
  if the target matches that identity; otherwise it is a conflict: no moved event, no backlink rewrites, plan kept as
  conflicted and shown. Regression per the audit.

## CC — browser live data (S3-006); e2e port 5481
In `apps/web/src/data/resync.ts`, an entry that drops events while idle (no observers, cache kept) is marked
**stale**; on re-subscribe its refetch is fenced: deltas are buffered (bounded, as today) and not applied until a
snapshot succeeds; a failed snapshot leaves the entry stale and retrying (same backoff as cacheless recovery), never
"successful with old data". Regression exactly as the audit describes (A at 10, idle, A at 11 dropped, resubscribe with
a failed fetch, B at 12 ⇒ not success with old A; then a successful snapshot repairs it), in the same epoch.

## DD — coding runtime bookkeeping (S3-004, S3-005); starts after batch AA merges; e2e port 5482
- **S3-004:** separate process completion from result persistence. After the CLI ended, the terminal outcome is kept
  in a durable **pending-delivery** record (DB row written before the first terminal attempt, or a file in the run's
  state dir if the DB is the failing part) and retried with backoff until committed; the active entry and the process
  record stay until the commit; the run shows "saving the result…" then a plain degraded note if it keeps failing.
  Never relaunch the CLI. On restart a pending-delivery record is committed before recovery marks anything interrupted.
- **S3-005:** in `process.ts` `noteMembers`, add identities to `noted` only after `onMembers` succeeded; on failure
  leave them eligible and retry on the next scan; inserts idempotent (already `INSERT OR IGNORE`), batch in one
  transaction; report persistent recording failure (log + a note) without claiming the processes are gone.
