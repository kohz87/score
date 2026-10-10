# Phase 2 gate review (lead, 2026-10-08)

Codex was out of credits, and the owner said "do it yourself if codex is unavailable", so the lead did the Phase 2
gate review. Scope: `7606576..main` (202 files, about 30.8k lines), all 20 Phase 2 tasks. Gemini was skipped for Phase 1;
the owner decides whether to run it for Phase 2.

**Verdict: pass after the fixes below.** One high finding (redaction across streamed chunks), three medium, three low.

## What was checked and held
- **Hermes boundary.** Hermes paths, URLs, CLI verbs and event names are only in `apps/server/src/hermes/`. The
  `kanban_*` names in `domain/` are Score's own ledger columns.
- **Processes.** Everything is spawned with `execFile` and argument arrays; no shell strings. Every argv that takes user
  text is safe against flag injection:
  - `--name=`/`--body=` forms with `--` before positionals (tasks, routines);
  - `Token` schemas that must start with a letter or digit (model, skills, tools);
  - `NoDash` (local providers);
  - a refusal of values starting with `-` (advanced config).
- **Credentials.** No reads of `.env`, `auth.json` or credential files. 2.19's status sources were checked in the
  Hermes source.
- **Hermes data.**
  - Hermes SQLite is opened only through `openReadOnly` (`query_only`).
  - The only file writes in the Hermes home are the D2.6 SOUL/AGENTS writer: `realpath`, exact file match, `O_NOFOLLOW`,
    `O_EXCL` temp file, `fsync`, rename.
  - Config writes go through `hermes config set` with re-read verification.
- **Human guard.** Every mutating route has `humanGuard` and idempotency receipts. The unguarded POSTs are only the
  previews (no writes), pairing and logout.
- **Events.** There is a single ingest path; only `hub/ingest.ts` inserts events.
- **Web.** No `dangerouslySetInnerHTML`. No agent-supplied URLs are rendered as links. The web calls only endpoints listed
  in the contract.
- **Limits.**
  - Message text is capped at 16 KB and task bodies at 32 KB.
  - Hand-offs are hop-limited.
  - The room-panel scan is bounded.
  - Advanced search returns at most 50 results.
- **Licensing.**
  - Migrations 0001–0012 are contiguous.
  - The license check is green.
  - Hermes-derived material (`config-index.json`, `pattern-keys.ts`) is credited in `THIRD_PARTY_NOTICES.md`.
  - No persona names ship in code. The config-index generator names them only to filter them out.

## Findings
1. **High: secrets split across streamed chunks escape redaction.**
   - *Where:* `appendRunMessage` (`domain/message-runs.ts`).
   - *What:* each `message.delta` is redacted on its own and then appended to the stored message and emitted as a
     `message.delta` event. A token split across two deltas (`sk-ab` + `cd12…`), or a context pattern split from its
     value (`Authorization: Bearer` + `eyJ…`, `api_key:` + value, a PEM block over several deltas), is stored and
     logged unredacted.
   - *Fix:* hold back the unfinished tail of each streaming message in `message_runs` (migration 0013) and emit only
     text that can't still be completed by a later chunk:
     - text up to the last line break, or up to the last whitespace when the line has no secret context before it;
     - from an unterminated `-----BEGIN` onwards, everything is held;
     - the hold is bounded.
     The tail is flushed (redacted) on completion and failure, and the whole text is redacted again at completion.
2. **Medium: approval cards for older approvals say "no longer available".**
   - *What:* the card looks the approval up in the first 50 items of `GET /api/approvals`.
   - *Fix:* add `GET /api/approvals/:approvalId` (contract §6). The card reads the approval by id when it isn't in the
     list.
3. **Medium: a per-agent stricter choice can't be undone.**
   - *What:* re-adding a Go-ahead returns `not_stricter`, and "Apply team rules" keeps the overrides. The owner has no
     way back to the team rules.
   - *Fix:* add **H** `DELETE /api/agents/:agentId/permissions/:permId`, which removes that override and returns the
     agent to the team baseline (never looser than the team). Add a "Use team rule" control on the Permissions tab.
4. **Medium (fixed during 2.18 integration): Advanced config could edit the approval keys.** Those edits bypassed the team
   baseline, the stricter-only rule and the verified write loop. Advanced now excludes `command_allowlist`,
   `approvals.deny` and `approvals.mode`.
5. **Low: Advanced can write `skills.disabled`.** That races the Skills tab's serialized read-modify-write. *Fix:* exclude
   it from Advanced, which also edits only the default profile. Model keys stay: both paths verify, and last writer wins.
6. **Low: the Team tab responses have no contract envelopes.** The skills, hub and memory responses aren't in
   `packages/contract`; the web parses the items with `AgentDetailSchema` parts and builds the wrappers ad hoc. *Fix:*
   add `SkillsResponseSchema`, `SkillHubResponseSchema` and `MemoryPageSchema` to the contract (doc §8 and the package),
   and use them on both sides.
7. **Low: the contract doc has a persona name in an example** (`"Fern, 2 passes"`). *Fix:* use a neutral agent.

## Rejected or deferred
- **Hermes "always" answers create drift.** The drift is shown and fixed only by a human ("Apply team rules"). That is
  the decided design (2.18 review, finding 3).
- **Memory add/delete and MCP tool toggles return 501 in live.** Hermes has no per-entry or per-tool mechanism. The UI
  says so.
- **Rule labels are capitalised pattern keys.** Cosmetic; friendlier names can come later.
- **Plan messages.** Nothing creates them yet; 2.7 only renders them. They belong to the Now/Flow work in Phase 3.
