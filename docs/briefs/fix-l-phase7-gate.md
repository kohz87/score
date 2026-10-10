# Fix batch L: Phase 7 gate findings (2026-10-10)

Source: `docs/reviews/2026-10-10-phase7-gate-codex.md` (Codex max, verdict "hold the gate"). Fix all seven; read each
finding's Where/What happens/Why/Fix. Follow AGENTS.md; no new dependencies; migration only if unavoidable (then 0052).

1. **[high] Deleted coding agents keep working MCP tokens** — revoke token + switches atomically with deletion (and with
   any agent removal path, Hermes agents too); MCP authentication checks the agent still exists and is active.
   Regression test: delete → old token refused (401) on every MCP tool.
2. **[high] Coding Stop abandons descendants when the CLI exits first** — keep escalation (SIGINT → SIGTERM → SIGKILL on the
   whole process group), process tracking and the agent's execution slot until the entire process group is gone;
   report the turn cancelled only then. Test with a signal-ignoring descendant whose streams are redirected (spawned
   via argv in a test fixture).
3. **[medium] Queued coding turns ignore permission downgrades** — re-read the agent's current permission level (and
   workspace) at dispatch time, not at queue time; a downgrade applies to queued turns. Test.
4. **[medium] Coding Watch frames store unredacted keys** — redact (D6) every coding-agent frame before storing, including
   partial/streamed chunks (redact on assembled text, not per chunk). Test with a key split across chunks.
5. **[medium] ZIP "Keep both" loses an incoming file** — keep-both must never drop or overwrite: suffix until free, also
   for names clashing within the same zip. Test.
6. **[medium] Summaries of lead notes block orchestration pruning** — treat summary references to lead notes like reply
   references (keep the referenced rows, account for them, prune the rest; never block maintenance). Test.
7. **[low] License checker permits MIT-0** — make the checker match AGENTS.md exactly (MIT, Apache-2.0, BSD-2/3, ISC; OFL for
   fonts). List every package currently passing only because of MIT-0 (or any other extra), add each to
   `license-exceptions.json` with `approvedBy: "pending owner review"` and a reason, and report the list — the lead puts
   it in the owner's decisions list.

Done when: failing test first for each (confirm it fails), lint, format:check, typecheck, contract/server/web suites,
license:check, the coding/knowledge/orchestration e2e specs green.
