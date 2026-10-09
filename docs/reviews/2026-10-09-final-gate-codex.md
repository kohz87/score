**Fail.** I would block release of `main` at `e12b77a`. I verified two credential leaks, recovery that queues work from the wrong conversation turn, and existing tasks escaping “Pause everyone.” All reproductions used synthetic data and in-memory databases; no files were modified. Deferred tasks 5.17a and 5.17b are excluded.

### [High] Known gateway keys leak when split across reply deltas

**Where:** [gateway.ts:160](/home/raven/score/apps/server/src/hermes/live/gateway.ts:160), [message-runs.ts:205](/home/raven/score/apps/server/src/domain/message-runs.ts:205)

**What happens:** A synthetic gateway key split into two deltas appeared intact in Chat storage and the durable event log. It remained after run completion, although `runs.output` was correctly masked.

**Why:** Exact-key replacement operates on individual frames. Neither frame contains the complete key. The message layer subsequently joins them but only applies pattern redaction, which does not recognize an unlabeled hexadecimal gateway key. Terminal reconciliation retains the streamed text.

**Fix:** Match known secrets across frame boundaries before persistence or publication, using volatile matching state. Add a regression covering split keys through terminal reconciliation.

### [High] Redaction buffer overflow exposes subsequent private-key material

**Where:** [message-runs.ts:148](/home/raven/score/apps/server/src/domain/message-runs.ts:148)

**What happens:** Streaming an unfinished PEM block exceeding 8 KiB causes later key-body chunks to enter Chat and the event log. The reproduced leak survived completion.

**Why:** Exceeding `MAX_HELD` forces the entire buffer to settle. Its opening delimiter is redacted and discarded, leaving subsequent chunks without the context needed to identify them as secret material. Masking the final output cannot retract previously published events.

**Fix:** Fail closed when unresolved secret text exceeds the limit: retain secret-state information and suppress unsafe continuations until a safe boundary or authoritative final output arrives.

### [High] Expired-run recovery can execute another turn’s handoffs

**Where:** [recover.ts:63](/home/raven/score/apps/server/src/hermes/live/recover.ts:63), [translate.ts:489](/home/raven/score/apps/server/src/hermes/live/translate.ts:489)

**What happens:** If Hermes admits a run but never persists its user message, a later manually resumed session turn can be recovered as that run’s answer. My reproduction marked the original run completed and queued the later answer’s `@reviewer` handoff.

**Why:** Recovery selects the first user message after `startedAt`, without proving it belongs to the original turn. Hermes has a verified shutdown path before user-message persistence. The recent “stop at the next user message” fix only protects histories containing the original user message.

**Fix:** Persist and verify an exact turn boundary. When history cannot establish the original turn, mark it interrupted and suppress handoffs.

### [Medium] Pause everyone leaves existing standalone tasks runnable

**Where:** [team-pause.ts:49](/home/raven/score/apps/server/src/http/team-pause.ts:49), [briefs.ts:325](/home/raven/score/apps/server/src/domain/briefs.ts:325)

**What happens:** Creating an assigned standalone task, then pausing everyone, returned success while leaving the task `todo` with no team hold. Hermes can promote and dispatch it while Score reports the team paused.

**Why:** The pause handler visits running briefs only. Team-owned task holds cover later arrivals; unchanged existing standalone tasks receive neither a hold nor a reconciliation event.

**Fix:** Record holds for all existing parkable tasks when setting the team pause, then apply them before returning success. Reuse the existing ownership-aware resume and recovery machinery.

## Checked and fine

- In-memory checks passed for LAN private-route denial, encoded-path denial, Host/Origin enforcement, `no-store`, single-use pairing, and producer/browser credential separation.
- Reviewed password guess reservations, sign-in stdin handling, exact approval identities and lease fencing, transactional ingest, profile backup-before-delete, and recent web stream/reconciliation fixes; no further blockers found.
- Lint, formatting, TypeScript checks and the license policy passed. Full `pnpm check` and E2E were not run because they create files.
## Lead response (2026-10-09)
All four findings accepted and fixed on `main`, each with a regression test that fails without its fix:
1. Split gateway keys → `d2c6821`: every key Score reads is registered (memory only) and `redact()` strips it verbatim
   wherever text is joined (`registerKnownSecret`, `redact.ts`; `readKey` in `credentials.ts`).
2. Held-text overflow → `d2c6821`: past 8 KiB the settled part is published and the reply takes the existing "lost" path
   (nothing more until the final output is redacted whole), so the PEM context is never dropped.
3. Recovery of another turn → `cffe853`: the first user message after the start must equal the input Score sent
   (`command_intents`), else the run ends interrupted with no hand-offs.
4. Pause everyone → `f0fdad4`: team holds recorded for every
   holdable task in the pause transaction and parked before the answer; Resume and recovery already release them.
Full checks after the fixes: server 1,986, web 495, contract 541, plugin 239, e2e 92/92.
