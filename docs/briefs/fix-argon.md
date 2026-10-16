# Fixes from the Gemini 4 Argon audit (`docs/reviews/2026-10-16-argon-audit.md`)

One builder, branch `task/fix-argon` (worktree `../score-worktrees/fix-argon`), in this order, each with a failing-first
test against the real modules (run it against the old code and say so). Rules as always: AGENTS.md, no new
dependencies, contract doc first, no pkill/killall or pattern kills, never touch 8740/8741 or the live Score, no git stash,
no `SCORE_E2E_DEV=1`, no background wait-loops, `git add <paths>`, don't merge. e2e port 5550 (the attempts spec uses
port + 1). Migration 0069 if needed.

1. **A1 (P1): compaction must never lose a dispatch witness.** A compacted `witness` (and a compacted `send_refused` /
   `send_closed`) becomes a tombstone that keeps `attemptId`, `orchestrationId` and the last generation, and
   `journalDispatches`/`unjournaledAttempts` recognise it, so an attempt with `dispatch_generation > 0` always has a
   journal record. Regression: an attempt refused or closed before launch, then terminated; run `maintenance()`
   (compaction), restart (`startupCheck`) ⇒ no `journal_truncated` freeze; a genuinely truncated journal still freezes.
   Also check the live-path order (fold then compact in one maintenance pass).
2. **A2: Claude Code activity after the result is loss.** An `assistant` record (text or tool use) or a `user`
   tool-result record after `result` makes the attempt lose authority (sticky), as Codex already does for messages after
   `turn.completed`. Check Codex too: an item (tool/command) after `turn.completed` must be loss. Regressions in
   `coding-drivers.test.ts`; the real-CLI replay (`/home/raven/.claude/jobs/999c85f0/tmp/clicheck/replay.mts` and
   `replay-v2.mts`) must stay `loss: null`.
3. **A3: `mcp_posts` retention.** The rate-limit log keeps only rows inside the longest rate window (plus a margin);
   cleared in the regular retention job (`hub/retention-aux.ts`). Regression: old rows go, rows inside the window stay,
   the limit still counts correctly.
4. **A4: MCP errors keep their details.** `guarded()` returns the HttpError's code, message and its `details` (e.g. the
   current `etag` on a `knowledge.write` conflict, `retryAfterSeconds`) to the agent, as the bridge path already does;
   never a stack trace or secret. Regression through the MCP tool call.
5. **A5: Claude deny rules list Grep, Glob, Write and NotebookEdit explicitly** for denied folders and files (next to
   Read and Edit). Update the worker policy's settings bytes accordingly (the policy id changes — that's expected; say so
   in the report). Regression on `claudeDenyRules`.
6. **A6: storage inventory counts per-generation coding records** (verify finding 7 first with a failing test; if it
   doesn't reproduce, report that instead of changing code).
Then `pnpm check`, the full e2e (SCORE_WEB_PORT=5550), the opt-in systemd suite and the real-CLI replays.
