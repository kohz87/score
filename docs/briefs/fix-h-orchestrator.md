# Fix batch H: live orchestrator findings from the 7.1 v7 review (2026-10-10)

Source: `docs/reviews/2026-10-10-7.1-workflow-builder-v7-codex.md` — three of its highs apply to the shipped 7.5 executor.
Migration **0049** (7.1 will use 0050+). Follow AGENTS.md; no new dependencies; don't commit to main.

1. **Termination provenance** (v7 H1). `runRecoveredObservation` (hermes/live/translate.ts) writes `runs.status =
   'completed'` from session-history text; the executor (domain/orchestration/executor.ts reconcile) treats that as
   termination evidence. Add `runs.terminal_source` (`runtime` | `recovered`; NULL = legacy runtime) set by every
   terminal writer; recovered runs keep showing their text to the person (unchanged chat behaviour) but for
   orchestration attempts they are **not** evidence: the attempt becomes `unknown` (`unknownReason:
   'recovered_text_only'`), its result is shown but not accepted, no successor is admitted, obligations stay. Test with
   an owned-run fixture: 404 + matching assistant text.
2. **Authorization revisions in the journal** (v7 H2). After the last dispatch, lowering a budget/limit, shortening or
   setting a deadline, revoking unknown-spend acceptance, and run/agent/team pause holds must be journaled
   (`transition` entries with an authorization revision) and verified at startup like the existing transitions: a DB
   that lacks a journaled restriction ⇒ global fence + reconciliation item. Tests: restore after each change with no
   further dispatch.
3. **Frozen agent mapping** (v7 H6). At run creation freeze the lead's and every allowed agent's incarnation. `orch.assign`
   refuses an agent whose current incarnation differs from the frozen one (`agent_changed`), and `beginSend` re-checks
   against the frozen mapping. A mismatch adds a `needsYou` item `remap` with a paired, revision-bound decision
   ("use the new builder for this run" → updates the frozen mapping and is journaled) or Stop. Contract + API-CONTRACT
   §14 + web (a Remap card next to the other Needs-you cards). Tests: replacement after Start before assignment, and
   between assignment and send.

Done when: tests for each, `pnpm lint`, `format:check`, `typecheck`, contract/server/web suites and the orchestration
e2e specs green. Report per item.
