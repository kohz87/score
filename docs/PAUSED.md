# PAUSED: Codex out of credits (2026-10-07)

**Status: all work paused, per the owner's rule** (CLAUDE.md, "If Codex runs out of quota"). Nothing further gets
reviewed, merged or coded, by Codex or by Claude, until the owner gives an explicit go.

## What stopped it
The adversarial review of task 1.13a (Codex CLI, `gpt-6.1-sol`, `max`, read-only) ended after ~126k tokens with:

```
ERROR: Your workspace is out of credits. Add credits to continue.
```

It wrote no review file. The partial run log is at `~/.score/codex/review-1.13a.log` (outside the repo). Its last
probes hint at findings to re-check on resume (unconfirmed, because the review never finished):
- the spool's directory cap appeared not to count a foreign or corrupt `.jsonl` file (10 KB file vs a 4 KB cap in a probe);
- a non-UTF-8 spool line raised `UnicodeDecodeError` while reading;
- a probe measured ~0.15 s against a 0.01 s budget on some code path (unclear which; re-check hook latency).

## State of `main` (e8eddce)
Merged and green (contract 318, web 200, server 604, e2e 13, plugin scaffold 1):
Phase 0; 1.1 contract; 1.2 server + pairing; 1.3 score.db; 1.4a ingest; 1.4b stream; 1.4c key retirement;
1.5 HermesPort + fake; 1.6 web shell; 1.7 stream client; 1.8 AgentGlyph; 1.9a SQLite readers; 1.9b reconciliation;
1.10 SSE client; 1.11a live gateway runs; 1.11b fingerprint gate; uv installed; `hermes-plugin/` scaffold.
Details per task: `docs/TASKLOG.md`.

## In flight: task 1.13a (bridge plugin), NOT merged
- Worktree `../score-worktrees/1.13a-bridge-plugin`, branch `task/1.13a-bridge-plugin` (based on f7a159d), all changes
  **uncommitted** in the worktree.
- Codex implementation session `01a113e2-cb89-7792-8bea-34305f15eb3e` finished before the credits ran out. Its report
  is at `~/.score/codex/runs/1.13a/round-0.md`: 75 pytest tests passing.
- Lead edits already in the worktree (uncommitted):
  1. Restored `tests/fixtures/l5-worker-hooks.json` to its recorded bytes (Codex had only reformatted it; the content
     was identical).
  2. Contract change: the bridge `hello` may report `isolation: 'unknown'` (observe-only; actions disabled). Applied to
     `docs/API-CONTRACT.md` §11, `packages/contract/src/bridge.ts`, `score_bridge/client.py`, `score_bridge/spool.py`
     and `tests/test_client.py`. Plugin tests (75), contract tests (318) and typecheck passed after the edits.
- Lead's own review notes, not yet acted on:
  - Payloads are queued by reference and scrubbed later on the sender thread. Hermes could mutate them after the
    hook returns, and up to 10,000 queued events can pin large objects.
  - After `os.fork()`, hook wrappers in the child still point at the parent's sender (no thread in the child).

## Not started
1.13b (gateway approvals, exact targets), 1.13c (Kanban grants + live test L6), 1.14 (approvals ledger + outbox),
then the Phase 1 gate (Codex `max` review + the owner's Gemini review).

## Resume checklist (after the owner says go)
1. Add `out of credits|add credits` to the quota patterns in `scripts/codex-task.sh` (this message wasn't
   detected) and use the same check for ad-hoc review runs.
2. Vet the 1.13a worktree's integrity: `git -C ../score-worktrees/1.13a-bridge-plugin status`, diff review, look
   for half-written files, then `pnpm check` and `uv run --offline pytest -q` in `hermes-plugin/`.
3. Re-run the 1.13a adversarial review (prompt: `~/.score/codex/review-1.13a-prompt.md`). Consider `high` instead of
   `max` to save credits, and confirm the three probe hints above plus the lead's two notes.
4. Fix findings, merge 1.13a, then continue with 1.13b in plan order.
