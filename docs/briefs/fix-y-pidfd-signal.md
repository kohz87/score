# Fix batch Y: identity-safe signals with pidfds (7.7a review finding 10)

Source: `docs/reviews/2026-10-11-7.7a-design-review.md` finding 10 (read it). After batch X, a pid-directed signal in
the process-group fallback (`runtimes/coding/proc.ts`, `killRecordedGroup`) still has a check-to-signal race: the target
can exit and its PID be reused between the last start-time check and `kill(pid)`. Shared rules as
`docs/briefs/fix-rstuv-audit2.md`; no git stash; no pkill/killall; never touch 8740/8741; nothing left running; don't
merge. No migration. e2e port 5472.

## Y1 — signal through a pidfd
- New helper `apps/server/src/runtimes/coding/pidfd-signal.py` (stdlib only, `python3 -I`, argv only): `pidfd_open(pid)`,
  then read `/proc/<pid>/stat` start time; signal with `signal.pidfd_send_signal(fd, sig)` **only** if it matches the
  expected start time (the pidfd pins the process, so a match after opening is proof). Exit codes: 0 signalled,
  3 identity mismatch / already gone, 4 pidfd unsupported, 5 other error. Batches of targets in one invocation.
- `proc.ts` uses it for every pid-directed signal (group signals to a **live recorded leader** still use `kill(-pgid)`
  because the leader's identity pins the group while it lives: verify the leader with a pidfd first, then signal the
  group through the leader's pidfd is not possible, so keep `kill(-pgid)` but only right after a pidfd-verified leader
  check, and document the remaining group-level assumption).
- If `python3` or pidfds are unavailable: never signal by number; return `unobservable` (fence + Release stays).
- Locate the interpreter once at start (`python3` on PATH, or `SCORE_PYTHON`), report it in Settings › Logs/health.

## Done when
Failing-first tests: a reused PID between check and signal is never signalled (real processes: start a sleeper, record
it, kill it, start sleepers until one reuses the PID if feasible in a test PID namespace — otherwise the injectable env
proves the helper is called with identity and the helper's own test proves mismatch handling with a real process);
helper unit tests in `apps/server/test/` (spawning the helper on harmless sleepers); unavailable python ⇒ no signal,
`unobservable`. `pnpm check`; coding e2e green.
