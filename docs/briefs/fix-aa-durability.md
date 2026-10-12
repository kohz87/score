# Fix batch AA: journal folder durability, native CLI under the fallback, journal outside the home

Source: `docs/reviews/2026-10-12-7.7a-v5-review.md` findings **1, 2, 3** (read them). Live code. Shared rules as
`docs/briefs/fix-rstuv-audit2.md`; no git stash; no pkill/killall; never touch 8740/8741; never read the real journal
in `~/.local/state/score`; nothing left running; don't merge. e2e port 5474.

## AA1 (#1) — every effect-permitting append makes the pathname durable
`ExecutionJournal.append` fsyncs the journal file **and its directory** before returning, every time (appends are rare:
one per dispatch/decision), so no flag can be forgotten across handles or processes. Compaction: after the rename, the
directory fsync must succeed before the compaction is considered done; on failure the next append's directory fsync
covers it (it always runs). Directory creation syncs each newly created ancestor. Tests: fresh-handle and separate-process
appends after a failed directory sync; failed post-rename sync followed by an append; ancestor creation synced.

## AA2 (#2) — the fallback runs the real executable
Before a fallback launch, resolve the CLI's real path. If it is a script (starts with `#!`) or a known launcher, resolve
the driver's native executable (Codex npm: the package's `vendor/<target>/codex/codex`; others: only if a documented
native path exists) and exec **that** under PDEATHSIG; if no native executable can be established, refuse the fallback
turn with a plain message ("This Codex install starts its engine through a launcher Score can't supervise without
systemd units; install the standalone Codex or enable systemd user services"). Tests: a harmless **spawning** launcher
script (parent dies ⇒ its spawned child must not survive: refused, or the native child exec'd directly), a native ELF
path accepted, the npm-layout resolution with a fake package tree.

## AA3 (#3) — the journal must live outside the home
Startup (`config.ts`/`start-server.ts`) and `scripts/restore.mjs` reject a journal directory whose canonical path
(realpath, resolving symlinks, including defaults derived from `XDG_STATE_HOME`) equals or is beneath the canonical
`SCORE_HOME`, **before** writing any marker or admitting work, with a clear message naming both paths. Changing the
journal root while a journal exists at the old root is refused unless migrated (`scripts/score journal-move <new>`
under the OS lock, or simply: refuse with instructions). Tests: equal path, nested path, symlink alias into the home,
XDG default inside the home, restore refusing before touching anything.

## Done when
Failing-first tests per item; `pnpm check`; coding and orchestration e2e green.
