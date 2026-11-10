# MD — model per chat (brief, decision 182)

Owner, 2026-11-10: `/model` sets an agent's model for **one chat**, like `/effort` (decision 178). Approved mock-ups, **binding**:
`docs/design/bold/mockups/27-model-main.dc.html` (group chat), `27-model-direct.dc.html` (direct chat), `27-model-agentsettings.dc.html`
(agent page Model row), `27-model-coding.dc.html` (coding agent), `27-model-jobs.dc.html` (the warning and repeating jobs).
`27-model-recipe` and `27-model-schedules` are **later**: don't build them. Copy values from the mock-ups, rebuild in React from the existing
components, never paste their HTML; where this brief and a mock-up differ, the mock-up wins and you report it.

The server and contract are done (read `docs/API-CONTRACT.md` §21 and `packages/contract/src/chat-models.ts`): `GET/PUT
/api/rooms/:roomId/models[/:agentId]` (the PUT answers `{ current, replaced }`; Undo puts `replaced` back), `GET
/api/agents/:agentId/chat-models`, `POST /api/agents/:agentId/routines/pin`, `RoutineSummary.model`, `Message.model`, event
`model.changed`. **Build the web side only** (`apps/web`, `e2e`). Mirror how `/effort` is built: `apps/web/src/bold/efforts/` (queries,
palette `effort-menu.ts`, command `effort-command.ts`, `EffortControl`, `MemberEffortTag`, `DirectEffortBlock`, `ChatRowEffort`,
`EffortChatsCard`, `bold/room/topic-commands.ts`, `routes/chat/use-composer-menu.ts`). Put the new code in `apps/web/src/bold/models/`.

## What to build
1. **`/model` in the bold composer**, both forms: bare `/model …` for the agent the message goes to, and `@agent /model …` in a group. A
   palette like `/effort`'s (mock-up `27-model-main`): header "Model for {agent} in this chat · its own is {its model}"; group ALIASES
   (the agent's aliases from `GET /api/agents/:id/model-settings`, each "/model {alias}" with "{model} · {provider label}"); group "MODELS
   IT CAN USE · type to search" from `GET /api/models?agentId=…&q=…` (narrows as the person types after `/model `; show up to ~5, then "+ N
   more: keep typing to narrow"); last "/model default" = "Back to {agent}'s own ({model})"; the note under it. A **coding agent** lists
   only its own program's models, `GET /api/coding-agents/runtimes/:runtime/models` (mock-up `27-model-coding`, no Codex group on a Claude
   Code agent), plus "/model default". Picking (or typing `/model <name>` and sending) calls the PUT; a note "You set {agent}'s model to
   {label} for this chat" with **Undo** (puts `replaced` back, or clears). Errors show as the effort ones do. The older bold rooms that
   handle `/effort` only (`isOlderRoom`) get `/model` the same way. **The classic shell's `/model` is unchanged** (it still sets the agent's
   own model via `PUT /api/agents/:id/model`); in the bold shell `/model` never calls that endpoint.
2. **One "model · effort" tag** wherever the effort tag is today: the context bar control, Chat info Members tags, the chat list row, the
   direct chat. Text: "{model label} · {effort}", the part that is the agent's own reads "its own" (muted); no tag when both are its own.
   Amber (the effort `max` style) when the model is set differently or the effort is max; otherwise the plain chip. Clicking it opens one
   menu with two parts: Model (the same list as the palette) and Effort (today's levels), each with "Back to its own". Its accessible name
   says both ("reviewer in this chat: model deep, effort max. Change").
3. **Direct chat Info, "This chat"**: a Model row (chip + "its own: {model}") above Effort; buttons Change model, Change effort, and Back to
   its own (clears both). Note text from the mock-up.
4. **Replies**: the label becomes "{agent} · {model} · effort {level}" (bold shell only), each part only when present (`Message.model`,
   `Message.effort`).
5. **Agent page › Model** (`apps/web/src/bold/agent-page/ModelSection.tsx`): the Model row's note "Every chat uses this unless it sets its own
   with /model." and, when there are any, "Set differently in N chats" opening the list from `GET /api/agents/:id/chat-models` (like
   `EffortChatsCard`, with the label as its tag).
6. **Repeating jobs show their model** (the Work section's repeating jobs summary and full card): "its own · {agent's model}" + "follows the
   agent", or "{model} · pinned". Read-only. The card's note: "Shown, not set here: a job follows the agent's model unless it's pinned. Keep
   them on the current model when you change the agent's model." (The mock-up's "ask the agent" is wrong: Hermes doesn't let the agent's
   cron tool pin a model.) The Model row also says "{N} repeating jobs follow it" when N > 0.
7. **The warning** (mock-up `27-model-jobs`), in the agent page's model change form (`ModelChangeForm.tsx`, bold only, Hermes agents): on
   Save, when the new model differs and at least one repeating job has no `model`, show the warning in place of saving, a `role="alert"`
   panel with `data-protected` (add it to the protected list and its test): title "{N} repeating jobs follow {agent}'s model", the jobs with
   their schedules, "Weekly report is pinned to deep and won't change" for pinned ones, and three buttons: **Keep the jobs on {current},
   then change** (POST `/api/agents/:id/routines/pin`, then the change; if the pin fails, say so and change nothing), **Change, jobs too**
   (the change only), **Cancel**. Under them the `/model` tip. Nothing changes until a button is pressed. A chat's `/model` never shows it.
8. Stream: `model.changed` updates the room's models and the agent's list the way `effort.changed` does for efforts.

## Rules
Follow AGENTS.md: bold tokens under `[data-ui='bold']`, `bold-` class names, theme tokens only, `data-protected` on the warning, 44px targets
on a phone, no horizontal page scroll, `AgentGlyph` for agents. **Every file at or under 450 lines** (split by job; `docs/CODEMAP.md` for
every file added or moved). **Never weaken or delete an existing test assertion**; tests that find the effort tag in its new combined form are
updated to the new text, each listed. Tests: the palette (Hermes with aliases, coding agent, filtering), the PUT and Undo, the combined tag
(both, model only, effort only, none, amber rule), the direct Info block, the reply label, the agent page list and job models, the warning
(all three buttons, the pin failure), the classic shell's `/model` unchanged. Add an e2e spec `e2e/bold-model-per-chat.spec.ts` (fake mode:
the fake lists `fake-model`, `local-gpt-mini`, …; aliases can be set through the agent page) covering `@builder /model …` in a group, the
tag, the reply label, Back to its own, and the warning with Keep the jobs; write it by reading, don't run e2e.

No new dependencies. Don't edit `docs/API-CONTRACT.md`, `docs/ARCHITECTURE.md`, `apps/server`, `packages/contract`, `hermes-plugin`. Don't
commit. Never run pkill or killall, never touch ports 8740 or 8741, never read `~/.hermes` or `~/.score`, never run real hermes, claude or
codex, never use `SCORE_E2E_DEV=1` or `git stash`. Work only in this worktree.

## Checks
`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`, and the vitest files you change or add. No full run,
no e2e.

## Report
Files changed, tests added or changed (with why), every difference from the mock-ups, open questions.
