**Fail — `main` at `a7961fd`.**

1. **Known gateway keys — still open.** The registered-key split reproduction now passes. However, [startup polls tasks](/home/raven/score/apps/server/src/hermes/live/live-port.ts:172) before [reading and registering keys](/home/raven/score/apps/server/src/hermes/live/credentials.ts:32). Synthetic keys leaked through that initial poll and an early authenticated bridge batch. Later registration masked subsequent observations but left the durable events exposed. Registration must precede ingestion.

2. **PEM redaction-buffer overflow — closed.** Replayed the original 320-line unfinished private-key block exceeding 8 KiB. No key-body fragments reached Chat or events, including subsequent chunks and terminal reconciliation.

3. **Wrong-turn recovery — still open.** The different-input reproduction now ends interrupted without handoffs. But when the original user row is absent and a later turn repeats `go`, recovery still marks the original run completed, stores the later answer and queues one `@reviewer` handoff. The [matcher](/home/raven/score/apps/server/src/hermes/live/recover.ts:24) also accepts multipart content containing one matching text part despite additional instructions. Content equality cannot establish turn identity.

4. **Existing standalone tasks escaping Pause everyone — closed.** The original assigned task now becomes `scheduled` with a confirmed team hold; Resume clears the hold and releases it. Standalone crash recovery and ordinary overlapping brief/team holds also passed. Additional pause blockers follow.

### [High] Pause can park a task that has already started

**Where:** [task-actions.ts:49](/home/raven/score/apps/server/src/hermes/live/task-actions.ts:49), [Hermes schedule_task](/home/raven/.hermes/hermes-agent/hermes_cli/kanban_db.py:4032).

**What happens:** Injecting dispatch between Score’s status check and CLI execution made Pause return `200` while changing a running task to `scheduled` and clearing its claim and worker PID. Executing Hermes’s isolated scheduling function against an in-memory running task confirmed this behavior and its run-finalization call.

**Why:** Score’s status check precedes the write transaction. Hermes’s scheduling operation accepts `running` tasks.

**Fix:** Use an atomic Hermes operation that parks only unclaimed `todo`/`ready` tasks. A concurrent start must leave the running task untouched.

### [Medium] Completed image turns fail recovery

**Where:** [recover.ts:24](/home/raven/score/apps/server/src/hermes/live/recover.ts:24), [attachments.ts:40](/home/raven/score/apps/server/src/hermes/live/attachments.ts:40), [Hermes persistence](/home/raven/.hermes/hermes-agent/agent/session_persistence.py:122).

**What happens:** Hermes projects `Inspect this image` plus an image into `Inspect this image\n[screenshot]`. A complete synthetic history using that actual representation was marked interrupted, losing its answer and handoffs. Attachment-unavailable notes caused the same failure.

**Why:** Recovery compares the original intent text with transformed stored content. Its JSON-parts fallback does not handle Hermes’s normal text projection.

**Fix:** Record the dispatched input and supported persistence representation alongside a verified turn identity. Preserve strict ownership checks when handling transformed content.

### [Medium] Restart leaves team-owned briefs paused after Resume

**Where:** [team-pause.ts:102](/home/raven/score/apps/server/src/http/team-pause.ts:102), [startup hold recovery](/home/raven/score/apps/server/src/app.ts:197).

**What happens:** Simulating a crash after clearing the team pause flag but before resuming its briefs left `teamPaused=false`, a paused brief and its task still `scheduled`. A fresh recovery instance returned **zero unresolved operations**, retaining the brief hold and team brief ledger.

**Why:** Recovery consults each brief’s remaining pause flag but never finishes the pending team-owned brief resumes.

**Fix:** Clear team-owned brief pause flags atomically with the resume intent, or replay unfinished brief resumes during startup recovery.

All reproductions used synthetic data and in-memory databases. No files were modified.
## Lead response (2026-10-09)
- **1 (keys before ingestion):** fixed. `registerStoredKeys` runs when the live adapter is built, before the bridge
  listens or the first task poll; new keys are registered when created. Test in `credentials.test.ts`.
- **2:** closed (confirmed).
- **3 (repeated input):** Hermes rows carry no run identity (checked `messages` schema and the runs API: no
  platform/message id is set for `/v1/runs`), so exact identity is not available. Recovery now requires the exact
  input *and* that Hermes stored it within 120 s of the run start; anything else ends interrupted without hand-offs.
  The multipart "extra text part" path is gone. Residual: a by-hand turn with identical text inside 120 s of a run whose
  own message Hermes never stored. Accepted as negligible; a true fix needs Hermes to tag the turn (noted for upstream).
- **4:** closed (confirmed).
- **[High] Pause can park a started task:** accepted as a **known limitation needing Hermes**: `schedule` accepts running
  tasks and has no status guard, and Score may not write Hermes SQLite. The race window is the CLI start-up between a
  fresh status read and the write. Upstream request added to `docs/proposals/hermes-attempt-fenced-stop.md`
  (`schedule --only-unclaimed`).
- **[Medium] Image turns:** fixed: matches Hermes's projection (text, optional unsent-image note, one `[screenshot]` line
  per image). Test in `run-recovery.test.ts`.
- **[Medium] Crash during Resume everyone:** fixed: team-owned briefs are unpaused in the same transaction as the team
  flag, so recovery releases their holds. Test in `arrival-holds.test.ts` (fails without the fix).
