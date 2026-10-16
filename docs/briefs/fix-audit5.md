# Fix batches for external audit 5 (`docs/reviews/2026-10-16-external-audit-5.md`)

Two builders in parallel with the Argon fix round (no shared files). Rules as always (AGENTS.md; contract doc first; no
new dependencies; no pkill/killall or pattern kills; never touch 8740/8741 or the live Score; no git stash; no
`SCORE_E2E_DEV=1`; no background wait-loops; failing-first tests against the real modules, run against the old code;
`git add <paths>`; don't merge). Migrations: K 0070, C none expected.

## Batch K (`task/audit5-k`, e2e port 5560) — Knowledge: S5-002, S5-003, S5-004, S5-005
1. **S5-002:** placeholders carry a stable per-note image index: `[image 2: alt, 69 B]` (the n-th embedded image of the
   note as the agent read it). `restoreImages` restores by index (validated against the current note; an index that
   doesn't exist or whose placeholder text doesn't match is left as text, never another image); old placeholders
   without an index restore only when unambiguous (exactly one original with that text), else the write is refused
   with a clear message to re-read the note. Update the agent-facing text (MCP tool and `hermes-plugin/score_bridge/
   knowledge.py` descriptions) to the new form. Regression: two equal-label, equal-size images, delete either, reorder,
   duplicate a placeholder, fabricated index.
2. **S5-003 / S5-004:** one history status with distinct states — `committed`, `unchanged` (already recorded in git),
   `not_versioned` (ignored path), `git_unavailable`, `failed` (pending) — carried in the save result (contract doc
   first; keep `versioned`/`historyUpdated` derivable for compatibility). Git unavailable is never reported as
   versioned or updated. An unchanged save checks whether the content is in HEAD for that path and, if not, retries the
   commit (history repair) before answering; the editor gets a "Save to history again" action when history failed, even
   with no text change. Regressions: no git / denied init / broken repo (save twice); commit fails then succeeds on an
   identical retry ⇒ a real repair commit; an already-committed no-op ⇒ `unchanged`.
3. **S5-005:** documents use the same history policy: size decides eligibility only; `place`, `ingestExisting`,
   `publishUpload` and the scan classify ignored paths as `not_versioned` and record the commit outcome; `commitPaths`
   returns it; upload and ZIP-import results carry the status; reconcile existing misclassified rows at startup (no
   force-add; a tracked file keeps history). Regressions through the real upload route and ZIP import (ignored CSV,
   image, binary), scan/restart, and an injected commit failure.

## Batch C (`task/audit5-c`, e2e port 5570) — coding: S5-001, S5-006, S5-C01
1. **S5-001:** authorise the transition that is committed: inside the writing transaction re-read the agent; if the
   committed change raises permission to `full` from the *current* value, a password verified for this request is
   required (verify outside the transaction, then recheck the agent revision/permission inside it and refuse with 409
   `conflict` if it changed); never write a stale permission. Regression through the real PATCH route: hold workspace
   validation, commit a downgrade, release ⇒ the downgrade stays unless the escalation is freshly authorised.
2. **S5-006:** one lifecycle owner: `close()` stops new binds, awaits (or cancels) `listenerAttempt`, and closes any
   listener that becomes owned during shutdown; a completed bind rechecks `closed` before publishing; repeated `close()`
   awaits the same cleanup. Regression with a real Unix socket: hold the bind, close, release ⇒ no listener survives;
   Check again overlapping shutdown ⇒ the process can exit.
3. **S5-C01:** trace whether a real output callback can still be pending after the launch's reservation is released
   (real ingestion, socket loss, proof, settlement). If reachable, make a late `chargeRetained` after release a no-op
   (or charge an owned reservation); if not reachable, add a guard anyway only if trivial, and report what you found.
