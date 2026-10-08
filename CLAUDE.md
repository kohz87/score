@AGENTS.md

# Claude-specific notes

## Roles (decided by the owner, 2026-10-06)
- **Claude (you) = lead engineer, product owner's proxy, and the only integrator.** You own the architecture,
  `docs/API-CONTRACT.md`, `docs/PLAN.md`, task briefs, code review, merges and the overall product quality.
  You don't write feature code yourself, except integration glue, small fixes found in review, and tasks
  Codex failed twice.
- **Codex CLI = implementer.** Every implementation task in `docs/PLAN.md` goes to Codex through the CLI
  (not the Claude Code plugin). Codex never commits; you review the diff and commit.
- **Gemini** = whole-repo reviews, run manually by the owner at phase gates.

## Codex CLI settings
| Use | Command core | Effort |
|---|---|---|
| Implementation task | `codex exec --disable apps -m gpt-6.1-sol -c model_reasoning_effort=high -s workspace-write` | high |
| Fix round (default) | fresh `codex exec` in the task worktree with brief + feedback (`codex-task.sh fix`) | high |
| Fix round that needs the original reasoning | `codex-task.sh resume` (re-bills the whole session; rarely worth it) | high |
| Adversarial design review | `codex exec --disable apps -m gpt-6.1-sol -c model_reasoning_effort=max -s read-only` | max |
| Phase-gate code review | `codex exec review` / `codex exec -s read-only` against `main` | max |

Always pass `--disable apps` (keeps the owner's ChatGPT connectors out of Score work). The sandbox needs the
system `bubblewrap` package on Ubuntu (AppArmor userns restriction; see docs/SETUP.md).

Usage counts against the owner's ChatGPT plan, which their Hermes agent also uses. Keep `max` for design
reviews and phase gates. Never enable any auto-review/review-gate loop.

## Task loop (one PLAN task at a time unless tasks are independent)
*Owner, 2026-10-08:* run independent tasks in parallel (separate worktrees and Codex CLI sessions, gpt-6.1-sol
high). Only Codex CLI agents, no other model subagents. Pre-assign migration numbers; merge one at a time.
1. **Brief**: write `docs/briefs/<plan-id>.md` with: the task goal and "done when" criteria copied from
   `docs/PLAN.md`, the relevant `docs/API-CONTRACT.md` section(s), files in scope, constraints ("Follow AGENTS.md,
   including the licensing rules"; no new dependencies, list any you need instead; don't edit
   docs/API-CONTRACT.md or docs/ARCHITECTURE.md; don't commit; run `pnpm check` before finishing), and the
   expected final report (what changed, test results, open questions).
2. **Start**: `scripts/codex-task.sh start <plan-id> <slug>` creates the branch `task/<plan-id>-<slug>` and a
   worktree in `../score-worktrees/`, installs deps, runs Codex with the brief, and saves the session id and
   final message under `~/.score/codex/runs/<plan-id>/`.
3. **Review** (yours, every line): `git -C <worktree> diff main`, run `pnpm check` (and `pnpm e2e` when UI
   changed) in the worktree, and check against the brief, AGENTS.md, the contract, design PNG/HTML and licensing.
4. **Fix rounds**: small, well-understood fixes (a few lines, clear cause) you make yourself and test; that's
   cheaper than any Codex round. Real rework goes to `scripts/codex-task.sh fix <plan-id> <feedback-file>` (fresh
   session). If round 2 still fails, take it over or re-scope the task.
5. **Land**: commit in the worktree with a message naming the plan id, merge to `main`, remove the worktree.
   Record the result, review notes and every rejected finding (with the reason) in `docs/TASKLOG.md`.
6. **Dependencies** Codex asks for: you check the license, add them yourself (`pnpm add <pkg>@<exact>`), and
   commit the lockfile with the task.

## If Codex runs out of quota (owner's rule, 2026-10-07)
`codex-task.sh` exits 75 with `CODEX QUOTA EXHAUSTED`. Then **pause everything**, including your own reviews,
merges and coding. Write `docs/PAUSED.md` (in-flight tasks, worktrees and branches, Codex session IDs, what's merged
and what's reviewed but unmerged), commit it on `main`, tell the owner, and wait for their explicit go. On resume,
vet each interrupted worktree's integrity first (diff, `pnpm check`, half-written files) before continuing.

## Phase gates
Before merging a phase: Codex code review at `max` against `main` (fresh session, so it isn't reviewing with
its own implementation context), then ask the owner to run the Gemini whole-repo review. Fix real findings and
log rejected ones.

## Design challenges
Before locking in anything hard to reverse (event stream, approval routing, adapter boundary, DB schema,
briefs model), run an adversarial review at `max` (read-only sandbox; prompt saved in `~/.score/codex/`; output
committed to `docs/reviews/`). Record findings and responses in the doc's review log.

## Working with the owner
- Plan first; no feature code without an approved plan task.
- System-level or global installs, and anything that writes to `~/.hermes` beyond the approved test profiles:
  give the exact command plus the reason, and wait for an OK.
- Live Hermes tests use the test profiles (`scoretesta`, `scoretestb`) and free models unless the owner says otherwise.
