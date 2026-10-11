# Fix batches R–V: second external audit (27 findings on 1.0.1)

Source: `docs/reviews/2026-10-11-external-audit-2.json` (verbatim findings: trigger, mechanism, fix, required regression
test) and `.md` (same, as prose). Read your findings there in full before starting. The audit's "required regression
test" is the minimum: every fix needs a test that **fails on the old code and passes with the fix** (check by stashing the
source change), reaching the real boundary named in the finding (route, service, real files, real child processes);
never close a cross-process, cancellation or durability finding with a simplified single-threaded unit test alone.

## Rules for every batch
- Follow AGENTS.md, including the licensing rules and `docs/WRITING.md` for any text a person reads.
- Work only in your worktree (`../score-worktrees/fix-<letter>`, branch `task/fix-<letter>-audit2`). Don't merge, don't
  commit to main. Small commits named after the finding ("S2-004 …").
- **Never use pkill, killall or pattern-based kills; kill only PIDs you started yourself. Never stop, restart or connect
  tests to the live Score on ports 8740/8741 or anything started from /home/raven/score. Before you finish, make sure no
  background shell, wait-loop or watcher you started is still running.** e2e only on your assigned `SCORE_WEB_PORT`.
- Harmless test children only (`node -e` sleepers); never run claude, codex, agy or a live Hermes; no model tokens.
- No new dependencies except where your batch says so. Don't edit `docs/ARCHITECTURE.md`. Contract changes: update
  `docs/API-CONTRACT.md` first, then `packages/contract`, then both sides, in the same change.
- Never run `prettier --write` on `docs/`.
- Before finishing: lint, format:check, typecheck, the suites for every package you touched (server/web/contract/plugin),
  and the e2e specs for the areas you touched.
- Final report: per finding, what changed, the test and whether it failed first; anything you chose differently from
  this brief and why; open questions; test counts.

## Batch R: coding-agent processes (S2-004, 005, 006, 007, 008, 009); e2e port 5450
- S2-004: in `spawnCli`, install every handler, timer and the stop interface **before** calling `onSpawn`; if `onSpawn`
  throws, terminate and reap the whole process group, then propagate.
- S2-005: supervise the **group**, not the leader. Stop and the wall-clock limit must act after the leader has exited
  while any group member lives (signal the group, SIGTERM then SIGKILL after the existing grace). Policy for a leader
  that exits successfully while descendants live: give them the existing grace period, then terminate the group, and
  record that in the run (plain note). `done` settles only when the group is gone; keep the durable process row until
  then. Note pgid reuse in a comment (we only signal a group we created and haven't seen empty).
- S2-006: carry the admitted model (`req.model ?? agent.model` at admission) through execution into `buildArgs`; the run
  row and the CLI argv must agree. A default changed while queued does not affect an admitted turn.
- S2-007: re-check stop/shutdown immediately before spawning (and between fallbacks); a turn stopped before launch never
  spawns and ends as stopped, without a visible queued→running transition.
- S2-008: a failed terminal observation is retried (bounded backoff) without relaunching; the active entry stays until
  it is persisted; after the retry budget the run shows a plain degraded state, never a silent success.
- S2-009: **decision: orchestrations and workflows run Hermes agents only.** Preflight and create (orchestrations) and
  save/start (workflows) reject coding agents with a clear error (`422 unsupported_agent`, message per WRITING.md). Add
  the error code to the contract doc. The executor stays Hermes-only.

## Batch S: Knowledge moves and publication (S2-001, 002, 003, 013, 014, 022, 027, 018, 019); e2e port 5451
- S2-001/002: replace `link`+unconditional `unlink` with the workspace's parked-identity approach (see
  `apps/server/src/workspace/workspace.ts`): atomically rename the source to a private parked name in the same folder,
  `link(parked, dest)` (EEXIST → conflict, put the parked file back without replacing anything that reappeared at the
  source: if the source exists, keep the parked file as a visible conflict copy and report it), then unlink the parked
  name. **No fallback to a replacing rename**: if hard links are unsupported (EPERM/ENOSYS/EOPNOTSUPP/EXDEV), fail closed
  with a clear error ("Knowledge needs a folder on a filesystem with hard links"). Distinguish ENOENT from other `lstat`
  errors. Share one helper between notes and documents (and with the workspace if that is a clean extraction).
- S2-003: every publication carries the conflict policy: new destinations publish with an atomic absence precondition
  (temp file + `link` no-replace), explicit replace uses a version (hash) precondition from the moment the person chose
  it. One shared preparation for single uploads and ZIP imports.
- S2-013: store the move plan in Score's own state (`$SCORE_HOME/knowledge/move-plan-<hash of the vault's real path>.json`),
  not under `.git`, so linked worktrees and any vault layout work; migrate an existing `.git/score-move-plan.json` once
  (read, move, delete) at start. A missing plan is not an error.
- S2-014: recovery revalidates every item; a deleted or changed completed item becomes a recorded conflict, the rest is
  finished, the plan always reaches a stable end, and recovery never fails Knowledge start-up.
- S2-022: the move response lists skipped backlink rewrites (`skipped: { path, reason }[]`); the move UI says which notes
  still link to the old name (contract change).
- S2-027: fsync the plan file and its folder before any namespace change, and progress in order; same for clearing.
- S2-018: ZIP note entries go through the same note validation as ordinary saves (`validateNoteImages` etc.): one shared
  prepare-and-validate function for writes, uploads and ZIP imports; a bad entry is reported, not silently written.
- S2-019: normalise `.markdown` (any case) and `.MD` to `.md` at the same boundary as `.txt`, with the same conflict rules.

## Batch U: workflow keys and browser state (S2-010, 011, 012); e2e port 5452
- S2-010: no plain-object lookups keyed by names people choose (step ids, input names, …) in contract, server or web:
  use `Map`, `Object.create(null)` or `Object.hasOwn`. Audit every such lookup in workflows and orchestrations, not only
  the two named. Keep `constructor`, `__proto__`, `toString` etc. valid names and test them.
- S2-011: the context meter clears its pending compaction when that exact command's result arrives; later compactions
  from elsewhere are independent updates (test two views, result before the POST resolves).
- S2-012: thread the `AbortSignal` through **every** `defineStreamQuery`/StreamQueryDefinition fetcher and `apiFetch`
  call (about 68); a test that the underlying fetch receives the abort on timeout, supersession, eviction and disposal,
  plus a lint-like test that fails if a definition's fetch ignores its signal.

## Batch V: lifecycle and cross-process (S2-023, 024, 025, 026); e2e port 5453
- S2-023: media scrub fairness: order by a persisted `verified_at` (migration **0053**, the only migration number you
  may use), dedupe shared physical hashes when budgeting; test that damage in a later row is found over several sweeps.
- S2-024: one inter-process lock shared by the server's setter and `scripts/set-password.mjs` (an exclusive lock file in
  the same folder with pid + process start time, stale-lock recovery), re-verify under the lock; credential and
  provenance published as **one** atomic file (or a documented, recoverable order). Test with two real processes.
- S2-025 (plugin, `hermes-plugin/score_bridge`): a re-registered plugin in the same process adopts and drains the outbox
  of the sender incarnation it retired (record retirement; per-incarnation ownership). PLUGIN_VERSION stays 0.1.0.
  Private Hermes calls only in `hermes_private.py`. pytest.
- S2-026: `retryUntilResolved` gets an awaitable stop/drain; hold recovery is registered in the server's job tracker so
  shutdown waits for an in-flight attempt before closing its dependencies.

## Batch T (starts after S is merged): Knowledge index, import and links (S2-015, 016, 017, 020, 021); e2e port 5454
- S2-015: per-file `lstat` errors other than ENOENT mark that path unverified (keep its index row, no deleted event).
- S2-016: `ingestExisting` returns an outcome (`unchanged | upserted | removed | unreadable`); removals are announced.
- S2-017: rebuild derives "versioned" from Git (`git ls-files` once per rebuild), not from first-upload size policy.
- S2-020/021: replace the hand-written code-range parser with `mdast-util-from-markdown@2.1.0` (MIT; already in the
  lockfile through react-markdown; add it to `apps/server` with the exact version and a license check): code and inline
  code ranges come from the parse tree's positions, shared by indexing, headings, images and rewrites. Fix the quadratic
  bucket copies in `buildNoteIndex` (push in place). Scaling tests (ratios, not absolute times) for inline spans and
  common basenames.
