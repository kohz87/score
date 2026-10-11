# Fix batch X: process-group proof, round 2 (from the 7.7 v2 re-review)

Source: `docs/reviews/2026-10-11-7.7-design-rereview.md` findings **N4, N5, N12** (read them in full). They are bugs in
the live coding runtime (batch W). Shared rules as `docs/briefs/fix-rstuv-audit2.md` ("Rules for every batch"): failing-
first tests, no git stash (patch/checkout/apply), no pkill/killall, never touch 8740/8741, nothing left running, don't
merge. Migration **0055** is yours if needed. e2e port 5471.

## X1 (N5) — absence is proven by the kernel, never by a scan
- "The group is gone" only when `process.kill(-pgid, 0)` fails with ESRCH (no process has that PGID), plus W's boot-id
  rule (another boot ⇒ gone). A `/proc` scan is used only to find **targets**, never to prove absence.
- Any stat read failure other than ENOENT (EACCES, EIO, malformed) during a scan ⇒ `unobservable`.
- The live reaper uses the same rule (no empty scan overriding a positive group check).

## X2 (N4) — ownership needs continuity
- While Score supervises a run, record the **identities** (pid + start time + boot id) of the group's members whenever
  it scans (at least when the leader exits with survivors, and on each re-reap), in the database (migration 0055).
- A group whose leader is gone may be signalled only through recorded identities that still match (pid + start time),
  plus processes whose parent chain reaches one of them at scan time. A member that matches nothing recorded makes the
  result `unobservable` (never signalled).
- Unresolved (`unobservable`) records keep the agent fenced (W2). Add a plain, deliberate **Release** action (Team page
  of the coding agent and the Chat notice): "Score can't tell whether these processes are its own. Check them yourself
  (`ps -o pid,pgid,args -g <pgid>`), then release the agent." Releasing records who released it and when, removes the
  fence, and never signals anything. Contract change: `POST /api/coding-agents/:id/release` (H, paired browser), in
  API-CONTRACT first.

## X3 — identity-safe signalling
Every pid-directed signal re-reads that pid's start time immediately before `kill`; a mismatch skips it.

## X4 (N12) — Stop means proof
`stopRun` on an active run returns `stopped` only after the group is proven gone (X1) within `stopObserveMs`;
otherwise `unconfirmed` (the stop keeps going in the background). Queued and no-row branches as W. The executor already
acknowledges only `stopped`/`not_running`; add the missing executor test that `unconfirmed` isn't acknowledged.

## Done when
Failing-first tests: the N4 scenario (replacement group whose leader exited: never signalled, `unobservable`), N5
(unreadable stat ⇒ unobservable; fork race: group-existence check catches a child missing from the scan), X3 (pid reused
between scan and signal), X4 (active Stop returns `unconfirmed` while a survivor lives, `stopped` once gone), Release
(contract, route, UI, audit trail). `pnpm check` and the coding e2e green.
