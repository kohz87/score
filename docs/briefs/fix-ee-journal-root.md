# Fix batch EE: journal ancestors, verified native CLIs, journal-root provenance, npm Codex layout

Source: `docs/reviews/2026-10-12-7.7a-v6-review.md` findings **1, 2, 3, 4** (read them). Live code (batch AA).
Shared rules as `docs/briefs/fix-rstuv-audit2.md`; no git stash; no pkill/killall; never touch 8740/8741, the real
`~/.score`, `~/.local/state/score` or `~/.config`; nothing left running; don't merge. e2e port 5483. Batch DD is working
in `runtimes/coding/process.ts`/`service.ts` at the same time: don't edit those two files.

## EE1 (#1) — ancestors durable before anything creates paths
The OS lock (`locks/os-lock.ts`) and every journal entry point create directories only through one `mkdirDurable` that
fsyncs each newly created ancestor's parent, **before** the lock file is created; a failed ancestor sync is recorded in a
small durable marker beside the lock (or simply re-synced: every journal open/append re-fsyncs the full chain of
ancestors up to the first pre-existing directory recorded at creation) so a fresh handle can't skip it. Test the real
startup order (`startupCheck` → `readRestoreMarker` before `open`) and a failed ancestor sync followed by a fresh-handle
append.

## EE2 (#2) — only a verified absolute native executable runs
`native-exec.ts`: no PATH, an empty PATH or relative PATH components never yield a bare command name; resolution returns
an **absolute, existing, ELF** path or refuses. The PDEATHSIG wrapper receives that absolute path and uses `execv`
(not `execvp`). Version detection uses the same resolved path. Tests: absent PATH, empty and relative components,
a script on Python's default path.

## EE3 (#3) — where the journal lives is recorded outside the home and outside the root
A provenance file outside both: `$XDG_STATE_HOME/score/roots.json` (default `~/.local/state/score/roots.json`), written
atomically under its own OS lock: home canonical path → journal root(s) ever used, with timestamps. At start: the
configured root is new for this home while provenance lists another root ⇒ refuse with instructions (move the journal,
or confirm); provenance missing/corrupt **and** the database shows any orchestration/workflow history ⇒ refuse admission
of executor work until reconciled (clear message). The `journal-root` pointer in the home stays as a convenience, never
the authority. Tests per the audit: backup before the pointer, work under J1, restore, start with J2 ⇒ refused.

## EE4 (#4) — the pinned npm Codex layout
Resolve Codex 0.160.1's native binary where its launcher does: the optional platform package
(`@openai/codex-<platform>/vendor/<target>/bin/codex`) and the package-local fallback (`vendor/<target>/bin/codex`).
Tests build both layouts exactly as the pinned launcher expects.

## Done when
Failing-first tests per item; `pnpm check`; coding and orchestration e2e green.
