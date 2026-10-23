# Proposal: the bold rework (UI + agent-to-agent)

Status: **direction approved by the owner (2026-10-23), not yet planned.** Turn this into `docs/PLAN.md` Phase 11
tasks and briefs before any code. Design sources: [`docs/design/bold/`](../design/bold/README.md).

## 1. Why

**The UI shows too much.** Seven top-level destinations; Now has Score, Flow (Runs, Workflows) and Routines; Watch per
agent; Chat has rooms, projects, direct rooms, "from elsewhere", a stage strip and three side cards; 12 tabs per
agent; 15 Settings sections; and a second shell (`/u`) that hides half of it. Three separate ways to get agents to
work together (rooms with @mentions, orchestrations, workflows) each have their own screen, log and approval card.

**Agent-to-agent (A2A) in rooms does not work as people expect.** Verified in the code on 2026-10-23:

| Problem | Where | Effect |
|---|---|---|
| Any reverse hand-off in a chain is stopped (`edges.some(e => e.from === to && e.to === from)`) | `apps/server/src/domain/routing.ts` `decideHandoffs` | builder → reviewer works, reviewer → builder ("sent back") is refused, so review loops end after one pass |
| Hand-offs are triggered by any `@name` found in a reply | `message-runs.ts` (`parseMessage(text).mentions` → `decideHandoffs`) | "as @reviewer said" starts a turn; an agent that forgets the `@` hands nothing off |
| Hitting the limit appends the text "Hand-off limit reached" | `message-runs.ts` | Silent; no way to extend or decide |
| Hop limit is per human message (`HANDOFF_HOP_LIMIT = 4`) | `routing.ts` | ARCHITECTURE D3.2 says 6, and "a pair at most 2 times"; code and doc disagree |
| The thread is flat | web `routes/chat/` | You can't see who holds the work, who waits on whom, or fold agent chatter away |

## 2. The concept

Three places: **Room**, **Team**, **Settings** (a gear), plus **Search** (⌘K) from anywhere. Dark first. Everything else is
folded in or removed (§5). Every screen is mocked in `docs/design/bold/` (20 boards; the README lists them).

1. **Team room** (`01-team-room.dc.html`; empty state `09`, a job's thread `11`): one room, always on, where you and the team talk.
   - **Jobs are tabs inside it** (All · Activity feed · Release notes · …). A job is a thread: your request, the
     agents' work, the result. The room's main stream shows only your requests, results (as cards), one-line job
     capsules ("builder and reviewer · 2 rounds · approved") and requests for you. "Open thread" shows the rest.
   - **Needs you is pinned** under the tabs (approvals, questions, paused exchanges), answerable in place.
   - **Composer** says which job it writes into ("To: Activity feed"); unaddressed messages go to lead, `@name`
     addresses one agent.
   - **Team dock** in the top bar: each agent's shape in a progress ring; clicking one opens its one-to-one.
2. **Side panel**, one dropdown: **Work**, **Library** (`13`, replaces Knowledge), a job's **Thread** (`11`), or a
   **one-to-one** with any agent.
   - **Work → Results** (default): what the team is making as cards: a live preview, "What changed" in plain words
     (who caught what), drafts, small live screens. Never opens on raw code.
   - **Work → Workbench** (`02-job-wide.dc.html`): the same work file by file: diffs with a bar in the colour of the
     agent who wrote each line, review comments pinned to lines, the agent's cursor; the agent's screen (read-only);
     drafts. Result cards link straight to the matching Workbench tab.
   - **One-to-one** (Claude-style, centred): private ("Only you and builder see this"), the panel takes the agent's
     colour. **Earlier chats** lists past one-to-ones with that agent (title, date, one-line summary) with search and
     "New chat". **Bring this into a new chat** attaches a reference chip ("Referring to: The cursor bug (Tue)").
     **Share to the team room** posts an answer into the room, labelled as shared from a one-to-one.
     "Take it aside with builder" on any job capsule opens this.
3. **Team** (`04-team.dc.html`; everything else about an agent `06`; add an agent `07`): four agent cards (state, where its computer is, a live screen glimpse, Message,
   Settings). Selected agent: how it works (personality), model, **works on** (local / Docker sandbox / SSH), and
   "asks you first before" (packages, pushing code, deleting files, using mouse and keyboard). Memory, skills, tools,
   plugins and channels sit behind one link.
4. **Settings** (`05`, `15`–`17`): Connections (Hermes, providers, channels, phone pairing), Look (dark default, light,
   motion, text size, themes, customizer), **Usage replaces Reports** (headline numbers, tasks per day, spend by agent,
   CSV, "Show as table"), System (team rules go / ask / never, service, updates, backups, logs, pause everyone).
5. **Phone** (`03`, `18`–`20`): job list with the pinned request, a job's chat, one-to-ones, team; tab bar Room · Team ·
   Settings.
6. **Getting started:** first run (`08`: Hermes found, pick agents, pick the lead, keep Score running), empty room
   (`09`), **Start a job** (`10`: recipe, repeat, ask-me-before, turn budget, spend cap, save as recipe).
7. **An agent's screen** (`12`): read-only screen with a plain-step log and a time bar; replaces Watch.
8. **Search** (`14`): jobs, one-to-ones, Library, messages and actions in one box.

Visual system and exact values: `docs/design/bold/README.md`.

## 3. Agent-to-agent, the target model (build this first)

- **Explicit actions, not prose.** Agents hand work over with Score tools, added to the MCP server Score already
  gives agents (it has `rooms.list`, `rooms.post`, `tasks.*`, `knowledge.*`): `handoff` (the work moves), `ask` (a
  question; the answer returns to the asker), `review` (ends in `approve` or `send_back`), `reply`. A bare `@name`
  in a reply is a mention and starts nothing. Keep `@name` from **the human** as addressing.
- **Replies route back automatically.** An `ask` or `review` result goes to whoever asked. `send_back` is allowed;
  the ping-pong guard is replaced by the budget below.
- **Exchanges.** Each back-and-forth between agents is a stored exchange: participants, job, kind, round, state
  (`live`, `waiting_on_agent`, `waiting_on_you`, `paused_budget`, `done`, `stopped`), turns used / budget. Stream event
  `exchange.upserted`. The UI's job capsules and the dock rings read from it.
- **A budget per exchange**, not per human message; visible ("5 of 8 turns"). When spent, the exchange **pauses and
  asks you**: give N more turns, let lead decide, or step in. No silent text.
- **Context per job.** An agent taking a turn reads its job thread (plus the room's pinned decisions), not the whole
  room, so a busy room doesn't make every agent read everything.
- **Step in.** You can write into an exchange; both agents see it without restarting lead.

This is hard to reverse (routing, sessions, schema), so per CLAUDE.md it needs an **adversarial design review at
max** before it's locked.

## 4. Data and contract changes (sketch; the design review decides)

Contract first: `docs/API-CONTRACT.md` → `packages/contract` → server and web, in the same change.

- **Jobs:** a thread inside a room. `messages.job_id`; job list per room with state; the Hermes session per
  (room, job, agent) instead of per (room, agent) (D3.1 today: `score-<room>-<agent>`). Migration: each existing room
  becomes a room with one job.
- **Exchanges:** new table and event, above.
- **One-to-one conversations:** many per (you, agent), each its own Hermes session; title + one-line summary (reuse
  the room summary machinery, `domain/room-summaries.ts`); searchable (reuse `domain/room-search.ts`).
- **References:** a message part that points to another conversation; the agent receives that conversation's
  summary with the message.
- **Share to room:** a message part copying a one-to-one answer into a job, with its origin.
- **Work items for Results:** previews, "what changed" summaries, drafts. Start from what Score already records
  (Watch frames: diffs, terminal output, browser screenshots; lanes; task activity) before adding anything.
- **Live screens:** Hermes has a Bot Screen (`bot_desktop.*`, `computer_use.*` in
  `apps/server/src/hermes/live/config-index.json`: a VNC desktop inside the agent's sandbox with a viewer and a
  takeover). Score shows it **read-only** (latest frame / viewer), never takes the keyboard (AGENTS.md D6, owner's
  rule) unless the owner changes that rule.

## 5. What happens to today's features

| Today | In the rework |
|---|---|
| Now › Score timeline, Flow, orchestration screens | Job capsules, exchange states, dock rings, Results. An orchestration becomes a job that lead plans |
| Workflows, Routines | **Recipes** and **Repeat** in Start a job (`10`) |
| Watch | An agent's screen (`12`): live, replay, plain-step log; glimpses in Results and on Team cards |
| Tasks board | Not a destination; jobs carry the state. Kanban data stays as the backing store if useful |
| Chat (rooms, projects, direct, from elsewhere, stage, side cards) | Team room + one-to-ones |
| Reports | Settings › Usage |
| Knowledge | **Library** in the side panel (`13`); agents' memory stays on their Team page |
| Customizer, themes | Settings › Look (dark default, light alternative) |
| Rules | Settings › System › Team rules (go / ask / never); per-agent "asks you first" on Team |
| Command menu | Search (⌘K) |
| `/u` chat-first view, admin/user split | Removed: the new shell is the simple one |
| Pets, room stage | Removed (the dock and capsules carry presence) |
| Team: 12 tabs | Four settings + "more" |

Keep old screens behind a flag until the new shell reaches parity; remove them only with the owner's OK.

## 6. Suggested Phase 11 order

1. **11.0 Design + review.** Write `docs/briefs/11.0-bold.md` from this proposal (jobs, exchanges, one-to-ones,
   sessions, references, migrations). Adversarial review at max; record the review in `docs/reviews/`.
2. **11.1 A2A routing** (server only): hand-off tools, reply-back, exchange records and budget, pause-and-ask,
   context per job. Fixture tests: send-back loop completes, budget pause, prose mention starts nothing.
3. **11.2 Contract:** jobs, exchanges, one-to-one conversations, references, share; fake adapter fixtures.
4. **11.3 New shell:** dark tokens, Room · Team · Settings, team dock with rings; old UI behind a flag.
5. **11.4 Team room:** job tabs, pinned needs-you, capsules, threads, composer addressing.
6. **11.5 Side panel › Results.**
7. **11.6 Workbench:** diffs with agent marks, comments on lines, read-only screens.
8. **11.7 One-to-ones:** history, search, references, share to room, "take it aside".
9. **11.8 Team page**, agent settings, add an agent.  10. **11.9 Settings** (four groups) **+ Usage**.
11. **11.10 Phone**, first run, empty room, Start a job, Library, Search.
12. **11.11 Retire old destinations** (owner OK), data migration verified on a copy of the live DB.
13. **11.12 Phase gate:** code review at max against `main`, then the owner's Gemini review.

Every task ships tests; UI tasks ship Playwright specs against the fake adapter and screenshots compared with
`docs/design/bold/`.

## 7. Owner decisions to confirm before building

1. **Dark by default.** AGENTS.md's design rules (ground `#ECEEF2`, white cards) change to the bold visual system;
   light stays as an alternative under Settings › Look.
2. **Removing** the Tasks board, Flow, the Score timeline, the room stage and pets, and `/u` as separate screens.
3. **Home is dropped** (the team room's pinned needs-you replaces it).
4. **Live screens stay read-only** (no "take the keyboard").
5. **Hop-limit doc mismatch** (ARCHITECTURE says 6, code says 4) is resolved by the exchange budget; pick the
   default budget (mockups use 8 turns).
6. The paused **10.15 swipe** work stays paused unless the owner says otherwise.
