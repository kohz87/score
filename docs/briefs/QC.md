# QC — Quota in a coding agent's chat (decision 186)

Owner, 2026-11-12: "when using coding agent, does it show remaining quota or can I use /status from codex and /usage from
claude code?" → mock-up approved ("mock up approved, go ahead"). Mock-up files: `docs/design/bold/mockups/30-quota-main.dc.html`
(desktop chat + Chat info), `30-quota-usage.dc.html` (/usage answer), `30-quota-low.dc.html` (states), `30-quota-phone.dc.html`.
**Read all four first; they are binding** (copy values from them; rebuild in React, never paste their HTML).

Web only. No server, contract or plugin change: the readings already exist (`GET /api/coding-agents/:id/quota`,
`CodingQuota` in `docs/API-CONTRACT.md`, the coding-agents section) and the helpers live in
`apps/web/src/routes/team/QuotaMeters.tsx` (`useCodingQuota`, `leftPercent`, `resetText`, `seenText`). Reuse them; move shared
pieces to a small module if a file would pass 450 lines. Hermes agents are unchanged everywhere.

## What to build (new shell, a coding agent's direct chat)
1. **Quota pill under the composer** (`bold/room/ContextBar.tsx`, the line with Context and Model): "Quota ▬ 62% left 5 h · 80% week".
   The bar is the 5-hour window (or the first window the CLI reports); each window's own % follows. It is a button (44px tall on a
   phone) that opens Chat info. Only for coding agents.
2. **Chat info** (`bold/direct/DirectInfo.tsx`): a section "Quota · <plan>" ("Claude plan" for Claude Code, "ChatGPT plan" for Codex,
   "Antigravity" with one row per model group): per window a label, "% left", a bar, "resets <time>" (`resetText`); then "Read after
   its <time> turn" (Claude Code, Codex; `seenText` of `seenAt`) or "Read <n> min ago" (Antigravity), the floor sentence ("Below 10%
   (its floor) Score starts no new work for it." with a "Change the floor" link to the agent page's coding section), and "Shared with
   every agent on the same <CLI> login."
3. **States** (30-quota-low): under 25% left the bar is amber; below the agent's `quotaFloorPercent` the pill becomes Score's light
   protected pill "7% left · below its 10% floor" (`data-protected`, added to the protected list and its test, AGENTS.md design
   rules) and Chat info adds "Score won't start new work for <name> until <reset>. What's running finishes." with "Change the floor"
   and "Use another agent" (to the Agents page). No reading yet: "Quota · shows after its first turn". A read error: "Quota couldn't
   be read" (no bar).
4. **/usage and /status** in a coding agent's chat (`routes/chat/composer-local-command.ts`, `context-meter.ts`): `/usage` keeps
   today's tokens/context lines and adds the quota windows (name, % left, reset) and when it was read; `/status` is the same
   command (an alias, listed in the slash menu with "Show tokens, context and plan quota"). Show a dollar cost only when the
   agent's context reports one. Hermes agents: `/usage` unchanged, `/status` not offered.
5. **Phone** (30-quota-phone): the footer line "Context 42% · Quota 62% 5 h · 80% week"; tapping Quota opens Chat info.
6. The reading refreshes when a turn of that agent ends (invalidate the quota query on the agent's run/turn end event the shell
   already receives; find it, don't add one) and at most once a minute while the chat is open.

## Tests
Vitest for the pill, Chat info section, states (low, below floor, none, error), /usage and /status text, and that Hermes chats show
none of it. E2E (write by reading; the lead runs): a coding agent's direct chat shows the pill and the Chat info section in fake mode
(check what fake mode gives for quota; if nothing, add a fixture in `apps/web` test helpers only, not the server), and /status answers.

## Rules for every task
Follow AGENTS.md: bold tokens under `[data-ui='bold']`, `bold-` class names, theme tokens only; anything that asks the person to decide
or warns them (the below-floor pill) carries `data-protected` and joins the protected list (`styles/protected.css` and its test); 44px
targets on a phone; no horizontal page scroll; `AgentGlyph` for agents. **Every file at or under 450 lines** (split by job);
`docs/CODEMAP.md` for every file added, moved or removed. **Never weaken or delete an existing test assertion**; tests that find
something in its new place are updated, each listed. **Audit before removing**: prove with a search that what you remove is unused.
No new dependencies. Don't edit `docs/API-CONTRACT.md`, `docs/ARCHITECTURE.md`, `apps/server`, `packages/contract`, `hermes-plugin`.
Don't commit. Never use pkill, killall or pattern-based kills; never touch ports 8740 or 8741 or anything started from
/home/raven/score; never read anything under `~/.hermes` except `~/.hermes/hermes-agent` (read-only) and never `~/.score`; never run
real hermes, claude or codex; never use `SCORE_E2E_DEV=1` or `git stash`; leave no background shell or wait-loop running.

Checks: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`, and the vitest files you change or
add (`pnpm --filter @score/web exec vitest run <files>`). No full run, no e2e. Report: files changed, tests added or changed (with
why), removals with proof, every difference from the mock-ups, open questions.
