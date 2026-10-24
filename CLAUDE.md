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
| Implementation on DeepSeek (NanoGPT subscription; see the 2026-10-24 roles below) | `CODEX_PROFILE=deepseek scripts/codex-task.sh start/fix …` (profile in `~/.codex/deepseek.config.toml`) | profile default |

Always pass `--disable apps` (keeps the owner's ChatGPT connectors out of Score work). The sandbox needs the
system `bubblewrap` package on Ubuntu (AppArmor userns restriction; see docs/SETUP.md).

Usage counts against the owner's ChatGPT plan, which their Hermes agent also uses. Keep `max` for design
reviews and phase gates. Never enable any auto-review/review-gate loop.

## Task loop (one PLAN task at a time unless tasks are independent)
*Owner, 2026-10-08:* run independent tasks in parallel (separate worktrees and Codex CLI sessions, gpt-6.1-sol
high). Only Codex CLI agents, except the Sonnet 5.5 fallback when Codex stops or runs out of quota (below).
Pre-assign migration numbers; merge one at a time.
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

## If Codex stops or runs out of quota (owner's rule, revised 2026-10-08)
`codex-task.sh` exits 75 with `CODEX QUOTA EXHAUSTED` (or Codex stops otherwise). **Don't pause**: continue the
affected and remaining tasks with **Sonnet 5.5** subagents (Agent tool, `model: sonnet`; reasoning effort can't be
set there, so it runs at its default). Same briefs, worktrees, review, tests and live checks as Codex work; at most
four in parallel. Adversarial reviews and phase gates are not done on Sonnet: if Codex is unavailable the lead does them
(owner, 2026-10-08), otherwise Codex at `max`. **Check hourly** whether Codex is available again (a tiny `codex exec` call, quota check on its output;
schedule a ~60-minute wake-up). When it is, new tasks go back to Codex; a task already started on Sonnet finishes on
Sonnet. Record the switch and each hourly result in `docs/TASKLOG.md`. (This replaces the 2026-10-07 pause rule.)

## Phase gates
Before merging a phase: Codex code review at `max` against `main` (fresh session, so it isn't reviewing with
its own implementation context), then ask the owner to run the Gemini whole-repo review. Fix real findings and
log rejected ones.

## Design challenges
Before locking in anything hard to reverse (event stream, approval routing, adapter boundary, DB schema,
briefs model), run an adversarial review at `max` (read-only sandbox; prompt saved in `~/.score/codex/`; output
committed to `docs/reviews/`). Record findings and responses in the doc's review log.

## Working with the owner
- *Owner, 2026-10-08 (later):* don't use Codex CLI for implementation any more. Use it only for **auditing** for bugs and
  problems: up to 6 parallel `gpt-6.1-sol` sessions at `high`, read-only. Implementation continues with Sonnet agents and
  the lead. *Revised the same day:* keep the audit running as a full audit (more waves as needed, not just one); when
  Codex runs out of quota, check hourly and resume auditing when it recovers, while the findings are fixed meanwhile (by
  the lead, with Sonnet agents where useful). While Codex is out of quota the lead audits too; the audit → fix → test → deploy
  loop keeps running unattended (owner checks back after ~15 h, 2026-10-08).
- *Owner, 2026-10-08:* keep working on implementation and deployment until the application is complete; the lead
  reviews all code (including phase gates and design reviews) itself. If a question to the owner gets no reply within
  5 minutes, proceed with the recommended option and keep going. Writes to the owner's real Hermes profiles (not the
  test profiles) are still prepared and asked about first, with other work continuing meanwhile.
- *Owner, 2026-10-24:* **three roles from Phase 11 on.** **Opus (the lead)** orchestrates: plans, briefs, starts
  tasks, decides on every finding, commits, merges, and keeps PLAN/TASKLOG. **DeepSeek through NanoGPT** codes: a Codex
  CLI profile, `CODEX_PROFILE=deepseek scripts/codex-task.sh start|fix …` (run it in the background; tasks outlast the
  Bash timeout). It bills the owner's NanoGPT subscription (verified $0 per call), not the ChatGPT plan. **Sonnet**
  reviews: a subagent (`model: sonnet`) gets the brief, `git diff main`, AGENTS.md and the contract/design sections, and
  returns findings only, never edits. The lead verifies each finding before it becomes fix feedback and logs rejected
  ones; `pnpm check` (and `pnpm e2e` for UI) is the gate, not the review.
  - **Who codes what.** The lead writes the hard, core work itself: design and plan (11.0), a2a routing (11.1), contract
    changes (11.2), live-data migration (11.11), anything at the Hermes adapter boundary or security, and phase gates.
    DeepSeek takes the well-specified bulk: UI screens built from `docs/design/bold/prototype.html`, routes, tests,
    settings sections.
  - **Pilot first.** DeepSeek's first task is **11.5 Side panel › Results**. Record in TASKLOG: fix rounds, Sonnet
    findings (real vs rejected), and how much the lead had to rework. Keep the split if it took ≤ 2 fix rounds and clean
    code; otherwise the lead codes the UI tasks and DeepSeek gets only tests and small tasks. Tell the owner the result.
  - **Fallbacks.** Two failed fix rounds: the lead (or a Sonnet coder) takes the task over. DeepSeek exits 75 (NanoGPT
    limit): Sonnet subagents code until it's back; record the switch in TASKLOG. Not for adversarial design reviews or
    phase gates (the lead does those, or Codex on `gpt-6.1-sol` when it has quota).
- Plan first; no feature code without an approved plan task.
- System-level or global installs, and anything that writes to `~/.hermes` beyond the approved test profiles:
  give the exact command plus the reason, and wait for an OK.
- Live Hermes tests use the test profiles (`scoretesta`, `scoretestb`) and free models unless the owner says otherwise.
