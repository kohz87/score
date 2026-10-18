# Cleanup round for 1.8.1 (owner 2026-10-18: "do the cleanup round after 1.8.0 completion")

Every item: a test that fails before the fix, plain words (docs/WRITING.md), contract doc first for any API change.

## C1 — Watch: real sub-agent nesting (not by caption)
Watch frames carry no parent id today, so S1 groups sub-agent steps by the "Sub-agent · " caption prefix (two
back-to-back sub-agents can merge into one group). Add `parentCallId` (and the Agent call's `subagent` summary where
useful) to `WatchFrame` in the contract (§ Watch) and the server's frame builder (from `tool_calls.call_id /
parent_call_id / subagent`, 8.7), then group by id in `watch-model.ts`; old frames without ids keep the caption fallback.

## C2 — Knowledge fixes
1. The "Save to history again" banner (shown after a save whose history step failed) disappears on reload although the
   note is still not in history: persist that state (derive it from the note's history status on load) so the banner
   survives a reload until history is repaired.
2. `GET` a note's `versioned` flag ignores whether Git is available: when Git is unavailable it must not claim
   `versioned: true` (match the save path's truthful statuses from 1.3.4).

## C3 — Remaining flaky tests
`themes-builtin-visual` "ledger chat, phone" (if still flaky after G1), `now.spec` design screenshot 1px height jitter,
`workspace.spec` 390px screenshot height jitter (22px), `kanban-attempts-audit5f` "a genuine copy stays visible…" (zod
`task_id` error under full load), `chat-composer` "Agents" listbox (intermittent), `live-feel` duplicate builder lane
(strict-mode). Same method as T1: reproduce with load/repeats, fix the cause, before/after rates.

## C4 — Themes polish (after the Phase 9 re-gate is clean)
1. Paper, Night shift and Dense become full built-in theme packages (like Harbour), so "Start from" in the Customizer
   copies them exactly (today it approximates via a hidden probe frame); the pack look must stay pixel-identical.
2. `PUT /api/themes/:id` can keep and add assets (and licence files) so the Customizer saves a theme with a picture or
   font without the import-replace route; If-Match and the revision etag apply; contract § 16 first.
3. Docs: `docs/USER-GUIDE.md` sections for Settings › Look, themes, the Customizer, the chat-first view, quota guard,
   coding personality and sub-agents (the guide predates Phases 8–9); refresh README screenshots that changed.
