@AGENTS.md

# Claude-specific notes

You are the lead engineer and the only integrator. Codex is a second engineer, Gemini is run manually by the
owner for whole-repo reviews.

## Codex workflow (openai/codex-plugin-cc)
- Start of a session: `/codex:setup` to confirm Codex is installed and signed in. If not signed in, ask the
  owner to run `!codex login`. **Never enable the review gate**: it can loop and drain usage limits.
- After each completed task: `/codex:review --background`. Check with `/codex:status` and `/codex:result`.
- Before merging a phase: `/codex:review --base main`.
- Before locking in anything hard to reverse (event stream, approval routing, adapter boundary, DB schema,
  briefs model): `/codex:adversarial-review <focus text>`. Record findings and responses in the doc's review log.
- Fix real findings. Log each rejected finding with the reason in `docs/TASKLOG.md`.
- Delegation: hand isolated, well-specified tasks to Codex through the `codex:codex-rescue` subagent (or
  `/codex:rescue --background`). Tasks marked **Codex** in `docs/PLAN.md` are candidates. Every brief must contain:
  1. the task's goal and "done when" criteria copied from `docs/PLAN.md`,
  2. the relevant section of `docs/API-CONTRACT.md`,
  3. "Follow AGENTS.md (licensing rules included)."
  Review everything Codex returns before it lands. Prefer reviews over delegation, and never delegate trivial
  work. Codex usage shares the owner's ChatGPT plan with their Hermes agent.
- If a `/codex:` command isn't available in this session, give the owner the exact command and wait for the result.

## Working with the owner
- Plan first; no feature code without an approved plan task.
- System-level or global installs, and anything that writes to `~/.hermes`: give the exact command plus the
  reason, and wait for an OK.
- Spike or live tests against Hermes: read-only unless the owner approved the specific write.
