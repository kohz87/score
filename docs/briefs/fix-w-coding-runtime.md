# Fix batch W: coding-runtime termination proof (from the 7.7 design review)

Source: `docs/reviews/2026-10-11-7.7-design-review.md` (Codex, max). These findings are bugs in **today's** coding
runtime (Chat uses it), independent of 7.7. Read the cited findings in full first. Same shared rules as
`docs/briefs/fix-rstuv-audit2.md` ("Rules for every batch"): failing-first tests at the real boundary (real harmless
child processes, a real temp database), no git stash, no pkill/killall, never touch 8740/8741, leave nothing running,
don't merge. Migration **0054** is yours if you need one (no other number). e2e port 5470.

## W1 (review #4) — never signal a process that isn't ours
`killRecordedGroup` (`runtimes/coding/proc.ts`) signals any member of the recorded PGID started after the recorded
leader, even when that PGID number now belongs to a new, unrelated group, and across reboots (start times are per boot).
- Record the boot id (`/proc/sys/kernel/random/boot_id`) with each process row (migration 0054). A row from another
  boot is gone by definition: never signal, the work is proven ended.
- Same boot: if a live process has `pid == recorded pgid` and it is not the recorded leader (start time differs), the
  group number was reused after ours emptied: signal nothing, ours is gone. If no process has that pid, members still in
  the PGID are ours (Linux never allocates a PID equal to a live PGID): signal them.
- Never signal by PGID alone without one of these proofs. Comment the reasoning.

## W2 (review #2) — recovery deletes a record only with proof
`killRecordedGroup` returns `'gone' | 'alive' | 'unobservable'` (no `/proc`, permission errors). `recover()` deletes the
`coding_processes` row only on `gone`; otherwise keeps it, marks the run with a plain note ("Some of its tools may still
be running"), keeps retrying in the background (bounded backoff), and the agent takes no new turn while a record of it
remains unresolved (clear message in Chat).

## W3 (review #1, #3) — "completed" only when the group is gone
- When the reaper can't confirm the group is gone, the run still ends (the reply is shown) but with
  `terminal_source = 'unconfirmed'`, the process row kept, background re-reaping, and the same no-new-turn rule as W2.
- Delete the process row in the **same transaction** that records the terminal observation (never before it), so a
  crash in between can't lose the result of work that ran.
- An `onSpawn` failure awaits termination of the group before rethrowing.

## W4 (review #7) — Stop says what really happened
`CodingRuntime.stopRun()` with no in-memory entry consults durable state: a queued intent → cancel it (proof: never
launched); a process row → kill it via W1/W2; no row and the run already ended → already stopped. Return an outcome
(`stopped | not_running | unconfirmed`) instead of unconditional success; callers that stamp an acknowledgement only do
so on `stopped`/`not_running`. Don't make Stop block other work (observe termination asynchronously).

## W5 (review #9) — no silent second execution
The resume fallback (a resumed CLI session the CLI no longer has → start fresh) may run only when: the first process
group is confirmed gone, no text or tool event was observed, and the error is a recognised pre-execution session refusal
per driver (not a generic "not found"). It shares the original wall-clock deadline (no fresh 30 minutes) and records
the second process without overwriting a live first record. Otherwise the turn fails with a plain note.

## Done when
Each item has a failing-first test (W1: a fake `/proc` and a real reused-PID scenario where possible, plus a different
boot id; W2/W3: survivors that ignore SIGKILL via a mocked signal function, crash between reaping and terminal write;
W4: each outcome; W5: refusal vs generic error vs observed output). `pnpm check` green; coding e2e green.
