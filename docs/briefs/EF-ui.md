# EF-ui — effort per chat on screen (brief)

Decision 178; design `docs/briefs/EF-effort.md`. Server and contract are done: read `docs/API-CONTRACT.md` section 20 and
`packages/contract/src/efforts.ts`. The approved mock-ups are **binding**: `docs/design/bold/mockups/25-effort-group.dc.html`,
`-direct`, `-phone`, `-agent-settings`. Copy their values, rebuild in React, never paste their HTML. Where this brief and a mock-up differ, the
mock-up wins and you report it. Sample names and numbers are not fixtures.

Follow the patterns of the subagent work just before this: `apps/web/src/bold/subagents/` (queries kept live from the stream,
`SubagentControl.tsx` for a context-bar menu with keyboard handling, `topic-commands.ts` for `/subagents`). Reuse, don't copy-paste: if you need a
shared piece, extract it.

## Parts
1. **Data** (`apps/web/src/bold/efforts/`, new): `GET /api/rooms/:roomId/efforts` kept live from `effort.changed`; `GET /api/agents/:agentId/efforts`
   for `own` and `levels`; `PUT /api/rooms/:roomId/efforts/:agentId`. Validate with the contract schemas.
2. **`/effort`** in the composer, handled by the composer, never posted (as `/subagents`): `/effort` shows the state; `/effort <level>`;
   `/effort default` goes back to the agent's own. In a group, `@agent /effort <level>` sets that agent; a bare `/effort` acts on the agent the
   message is addressed to (the "To" chip). The slash menu lists only that agent's `levels`, plus "Back to {agent}'s own ({own})", with the mock-up's
   header and note. A level it doesn't take: say which it takes, send nothing. After a change, the one-line note in the chat as in the mock-up, with
   **Undo** (puts back what it was). `effort.changed` with `reason: model`: the note says it went back to the agent's own because its levels changed.
3. **Context bar** (`ContextBar.tsx`): "Effort {level}" beside the model, for the agent being written to, only when this chat sets one; it opens
   the same choices (same menu behaviour as `SubagentControl`). `max` uses the amber style from the mock-up; others the plain one.
4. **Chat info › Members** (group): a tag on each agent set differently ("Effort high"); none for its own. Each tag is a button opening the choices
   for that agent. The note under the list from the mock-up.
5. **Direct chat**: Info's "This chat" block (Model, Effort with "its own: …", Subagents) with **Change effort** and **Back to its own**; the chat list's
   small level tag beside the agent's name when set.
6. **Phone** (`-phone`): the Members sheet with tag buttons (44px), "Its own" for an agent not set.
7. **Replies**: an agent message with `effort` shows "{agent} · effort {level}" in its name line.
8. **Agent settings › Model** (`-agent-settings`; find the Model card in `apps/web/src/bold/agent-more/` or the Model settings): "Set differently in N chats",
   each chat a link with its level, and the line under them. Nothing when N is 0.

## Rules
Follow AGENTS.md:
- These are settings and status, not decisions for the person: no `data-protected`. Tokens under `[data-ui='bold']`, class names prefixed `bold-`,
  theme tokens (map the mock-up's colours to existing variables; add an amber token beside the others if none fits, in the same tokens file).
- `AgentGlyph` wherever an agent is shown; never colour alone.
- Tap targets at least 44px on a phone; no horizontal scroll.
- Every file at or under 450 lines (`ContextBar.tsx`, `ChatInfo.tsx`, `topic-commands.ts` are big: put new parts in new files). `docs/CODEMAP.md` for
  every file added or moved. Audit first: note anything unused in what you touch; remove only what you can prove unused, with proof.
- Tests for every part: set, change, back to own, Undo, wrong level, group `@agent /effort`, reason `model`, nothing shown for an agent on its own, the reply label,
  the agent settings list, keyboard on the menu.
- Never weaken or delete an existing test assertion.

No new dependencies. Don't edit `docs/API-CONTRACT.md`, `docs/ARCHITECTURE.md`, `e2e/`, or anything under `apps/server`, `packages/contract`, `hermes-plugin`:
if you need a change there, stop and say what. Don't commit.
Never run pkill or killall, never touch ports 8740 or 8741, never read `~/.hermes` or `~/.score`, never run real hermes, claude or codex, never use
`SCORE_E2E_DEV=1` or `git stash`. Work only in this worktree.

## Checks
`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`. You may run the vitest files you write or change
(`cd apps/web && npx vitest run <file>`). No full run and no e2e.

## Report
Files changed, checks' results, each part's state, every difference from a mock-up, audit findings.
