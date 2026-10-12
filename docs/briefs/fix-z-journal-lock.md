# Fix batch Z: journal writes, OS locks, fallback lifetime (7.7a v4 review #2, #3, #5)

Source: `docs/reviews/2026-10-12-7.7a-v4-review.md` findings **2, 3, 5** (read them in full). Live code. Shared rules
as `docs/briefs/fix-rstuv-audit2.md`; no git stash; no pkill/killall; never touch 8740/8741; nothing left running; don't
merge. No migration of Score's DB expected. e2e port 5473.

## Z1 (#2) — a journal record is written whole or not at all
`domain/orchestration/journal.ts` `append()` (and every other writer: tail repair, compaction, markers): loop
`writeSync` until the whole encoded buffer is written; a zero-byte write or any error throws **before** the caller is
allowed to act; every required `fsync` (file and directory) propagates its error (no swallowing). Invariant, in a
comment: no external effect is permitted by a record that recovery could discard. Tests with an injected short write
(partial bytes, then success) and an injected fsync/dir-sync failure: the caller never proceeds; restart sees no record
and no effect was permitted.

## Z2 (#3) — locks are OS locks, never stolen
A shared module `apps/server/src/locks/os-lock.ts` (Node built-ins only, `node:sqlite`): an exclusive lock is an open
`DatabaseSync` on a permanent sidecar file (`<dir>/lock.sqlite`, created once, never renamed or deleted) holding
`BEGIN EXCLUSIVE` for the critical section, with `busy_timeout` for waiting and a clear timeout error; the kernel
releases it if the process dies, so there is **no stale-lock logic**. Use it for:
- the security password store (replace `withPasswordLock`'s file protocol; `scripts/set-password.mjs` uses the same
  module), keeping the public behaviour (409 on timeout, re-verify under the lock);
- the orchestration journal: every read-for-decision, tail repair, append, sequence allocation and compaction (the
  lock file lives beside the journal and is never the renamed file). This also closes the multi-home race (v2 review #3).
Tests: two real processes contending (one holds, the other waits then proceeds); a holder killed with SIGKILL releases
the lock immediately; the old stale-stealing interleaving from finding 3 is impossible (no rename/unlink of the lock);
journal compaction in one process and append in another never lose the append.

## Z3 (#5) — the fallback's CLI dies with Score, and is recorded before it gets its prompt
- Launch fallback CLIs through a tiny wrapper (`runtimes/coding/pdeathsig-exec.py`, stdlib, `python3 -I`, argv only)
  that sets `prctl(PR_SET_PDEATHSIG, SIGKILL)` and checks the parent is still Score (getppid unchanged) before `execvp`
  of the CLI, so the CLI is killed when Score dies. Descendants of the CLI are not covered: say so in a comment and in
  Settings › Coding ("tools a CLI started may keep running until Score restarts and stops them").
- Reorder the fallback launch: spawn → record the process durably (`onSpawn`) → **then** write the prompt to stdin.
  A crash between spawn and record leaves a CLI that has no prompt and dies with Score.
- Without python, the fallback refuses to start coding turns with a clear message (as the pidfd helper already does
  for signals).
Tests: kill the Score-like parent (a harmless test parent process) and the wrapped sleeper dies; the prompt is written
only after the record exists (a record failure means the CLI never received its prompt); no python ⇒ refusal.

## Done when
Failing-first tests for each item; `pnpm check`; the coding and orchestration e2e green.
