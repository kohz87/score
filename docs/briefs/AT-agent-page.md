# AT — the agent page, tidied (brief)

Owner, 2026-11-10 (decision 180): workspace is shown in the chat, so the agent page needn't; the page has duplicates. Mock-up approved:
`docs/design/bold/mockups/26-agent-page.dc.html` (desktop) and `26-agent-page-phone.dc.html` (phone). **Binding**: copy its values, rebuild in React
from the existing components, never paste its HTML. Where this brief and the mock-up differ, the mock-up wins and you report the difference.

This is a **layout change**: the same settings, the same routes, no server or contract change. Every setting the page has today stays reachable, except the
Workspace card, which goes.

## Today
`apps/web/src/bold/BoldAgent.tsx` (header, Personality, Runs on / Model card with Effort, Fallback models, Aliases, Speech models, the "Where it works"
card, "Asks you first before", then a More/Less toggle) and `apps/web/src/bold/BoldAgentMore.tsx` (cards under `apps/web/src/bold/agent-more/`:
Remembers, Skills, Can use, Workspace, Repeating jobs, Subagents, Delete, Plugins, Channels, Goes ahead without asking, Never rules, Looks, Name and role,
Recent runs, Score access, Todo). A coding agent's page differs (`CodingOverview`, its own cards): apply the same sections to it, leaving out what doesn't apply.

## The new page (from the mock-up)
- **Header:** look, name, role, an **Edit** button (opens name, role and look: today's Name and role and Looks cards, in a dialog or an inline panel);
  "Hermes · reports to lead · working · needs you"; **Message**, **Pause**, and a **⋯** menu with "Look at its screen" and the other header links. No "Works in".
- **Section menu** on the left (desktop: sticky in the page's flow, never `100vh`; phone: a row of chips that scrolls sideways inside itself, 44px), jumping to:
  **Personality, Model, Safety, Tools, Memory and skills, Work**, then **Remove {agent}** at the bottom (opens today's Delete flow). One column of sections, no More/Less.
- **Personality:** as today (SOUL.md / AGENTS.md).
- **Model:** summary rows, each with its button, opening today's form for that row in place (one at a time is fine):
  Model (Change) · **Default effort** with "Every chat uses this unless it sets its own with /effort. Set differently in N chats" (the link opens today's
  `EffortChatsCard` list) · "If it's unavailable" = fallback models (Add fallback / Edit) · **Model aliases** with "used as /model {alias}" (Edit) ·
  **Voice** = speech models (Edit) · **Subagents** = today's SubagentsCard (Edit).
- **Safety:** four tiles: where it runs (today's "Where it works", Change where it works), Asks you first before, Goes ahead without asking, Never rules.
- **Tools:** Can use; Plugins (summary + Manage); Reachable on = Channels; Score access.
- **Memory and skills:** Remembers and Skills, as summaries with Open memory / Manage skills that open today's full cards.
- **Work:** Recent runs, Repeating jobs, Todo.
- **Removed:** the Workspace card (`agent-more/WorkspaceCard.tsx`) and the header's "Works in". **Audit first** (AGENTS.md): prove what else becomes unused
  (its test, helpers like `RecentFiles` if nothing else uses them, CSS) with a search per item; remove only what's proven unused; list each with its proof.
  Anything still used elsewhere (Settings › Workspaces, Library) stays.

## Rules
Follow AGENTS.md:
- Tokens under `[data-ui='bold']`, `bold-` class names, theme tokens only. Anything that asks the person to decide keeps `data-protected` (Delete, Never rules,
  Goes ahead, permissions) exactly as today. `AgentGlyph` for the agent. 44px targets on a phone; no horizontal page scroll.
- **Every file at or under 450 lines**: split by section into new files (`apps/web/src/bold/agent-page/…`). `docs/CODEMAP.md` for every file added, moved or removed.
- **Never weaken or delete an existing test assertion** about a setting that stays. Tests and e2e that find things by the old layout (the More button, card
  headings that changed) are updated to the new place, not loosened: list each one you change and why. Tests of the removed Workspace card go with it (list them).
- Tests for: the section menu, each summary row opening its form, the header Edit, Remove, the coding agent's page, the phone chips.

No new dependencies. Don't edit `docs/API-CONTRACT.md`, `docs/ARCHITECTURE.md`, anything under `apps/server`, `packages/contract`, `hermes-plugin`.
Don't commit. Never run pkill or killall, never touch ports 8740 or 8741, never read `~/.hermes` or `~/.score`, never run real hermes, claude or codex,
never use `SCORE_E2E_DEV=1` or `git stash`. Work only in this worktree.

## Checks
`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`. You may run the vitest files you change. No full run, no e2e
(you may update e2e specs by reading them; the lead runs them).

## Report
Files changed, the audit's removals with proof, each test or spec changed and why, every difference from the mock-up.
