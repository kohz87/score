# Bold rework: feature parity checklist

Companion to [`ui-rework-bold.md`](ui-rework-bold.md). Every user-facing feature Score has today (from
`docs/USER-GUIDE.md` and `apps/web/src/routes/`, 2026-10-23), where it lives in the new design, and its status.
**Nothing on this list may disappear silently.** The 11.0 brief must give every row a home or an owner-approved drop,
and the phase gate checks this list.

Mockups are `docs/design/bold/NN-*.dc.html` (numbers below). **Owner decisions of 2026-10-24 (D1–D13) are in the
proposal's §8 and override the statuses below where they differ**: workflows → recipe editor; run safety →
cards; coding agents share the agent page; message actions; rooms → room dropdown (`21`) + job menu;
settings sections. Those are drawn in the clickable prototype `docs/design/bold/prototype.html`; pop-out dropped; pet packs, looks, stage and Lively dropped (20 shapes kept); Tasks
board merged into jobs; admin view and `/u` dropped; Usage keeps first-time pass and waiting-on-you; webhook triggers.

Status:
- **Drawn**: the mockup shows it.
- **To design**: keeps working; the new screen isn't drawn yet. The task brief designs it in the bold visual system
  before building.
- **Folded**: the behaviour stays but moves into another feature (named).
- **Owner**: proposed change or drop that needs the owner's yes (also listed in the proposal's §7).

## Shared ideas

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Agents shown by colour + shape (AgentGlyph) | Unchanged, everywhere | all | Drawn |
| "Needs you" dark cards | Light cards on the dark ground; pinned in the team room | 01, 18 | Drawn |
| Pairing (looking is free, changing needs a paired browser) | Unchanged; pairing page restyled | — | To design |
| Search or run a command (Ctrl/Cmd+K) | Search: jobs, one-to-ones, Library, messages, actions, settings sections | 14 | Drawn |
| Pause everyone / Resume everyone | Team (phone), Settings › System, Search | 17, 20 | Drawn |
| Browser notifications (per kind) | Settings › Connections or System › Notifications | — | To design |
| Installable app (PWA) | Unchanged | — | Folded |
| Secrets redaction, never reading credential files | Unchanged (not UI) | — | Folded |

## Now (Score timeline, Flow, Routines)

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Headline ("Two agents are working…") | Team room + dock ("Rings show how far along…"); phone job list | 01, 18 | Folded |
| Score timeline: one row per agent, blocks, Now marker, planned blocks, hand-off lines | Job capsules, dock rings, a job's thread by rounds. **The per-agent timeline itself is dropped** | 01, 11 | Owner |
| Thread card, approval card ("Always allow this for <agent>"), Made today | Team room stream, pinned needs-you, Results | 01 | Drawn |
| "Always allow this for <agent>" on an approval | Approval card's More menu | — | To design |
| Flow: graph of one run, step inspector (who, state, checklist, model, tools, time) | A job's thread by rounds + Workbench; step details on demand. **The graph view is dropped** | 11, 02 | Owner |
| Flow: Stop this step, Pause / Resume run, live log, numbers | Thread header (pause/stop the job), System › Logs, Usage | 11, 17 | To design |
| Routines list (read-only, last run) | "Repeat" on a job; list of repeating jobs on Team › agent and in Search | 10 | To design |

## Orchestrations

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| New orchestration: goal, lead, agents allowed, when to ask, budget, deadline, limits | Start a job: recipe "lead decides", ask-me-before, turn budget, spend cap; **deadline and agents-allowed list to add** | 10 | Drawn (partly) |
| "Before it starts" checks + acknowledgement | Start a job, before Start | — | To design |
| Run page: live diagram, request log, plan, budget and limits | Thread + Results; plan as a card in the room | 11 | To design |
| Step approval cards, Pause / Stop | Pinned needs-you; thread header | 01, 11 | Drawn (partly) |
| "Not confirmed ended" decision | Card in the thread | — | To design |
| Quota-guard card: use anyway / wait until reset / stop | Pinned needs-you card | — | To design |
| Spend not settled, reserved amount | Thread header and Usage | — | To design |

## Workflows

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Saved workflows list | "Your saved recipes" in Start a job | 10 | Drawn (entry only) |
| Editor: agent steps, gates, branches (verdict / outcome / contains), joins, ends, retries 0–2, failure paths, `{{nodes.*}}` / `{{inputs.*}}` templates, live checking, undo / redo | **Recipe editor**: a step list (graph optional) with the same building blocks | — | To design |
| Save as new version (immutable), conflict, start from an older version, Export (scrubbed) | Recipe editor | — | To design |
| Run…: inputs, approvals mode, budget, deadline, unknown-cost policy, agents, checks | Start a job with a recipe selected | 10 | To design |
| Run page: diagram (gate diamond, branch hexagon), plain log, Retry / Try again / Remap cards, replay of finished runs | Thread by rounds + cards in the room | 11 | To design |

## Watch

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Replay of terminal, diffs, browser screenshots | An agent's screen | 12 | Drawn |
| Live follow, timeline markers, arrow-key stepping, Live | Time bar with markers, step buttons, Live | 12 | Drawn |
| Approval bar while waiting | Pinned needs-you and on the screen page | — | To design |
| "What they're doing" | Plain-step log | 12 | Drawn |
| "Other screens" | Screens row in Results; Team cards | 02, 04 | Drawn |
| Pause <agent>, Open in terminal (`hermes -p … --resume`) | Agent settings; screen page note | 06, 12 | Drawn |
| Live Hermes Bot Screen (`bot_desktop`, `computer_use`), read-only | Same page, live frames | 12 | To design (new) |

## Chat

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Rooms (several agents) | One always-on team room with jobs as tabs. **Multiple separate rooms become jobs** | 01 | Owner |
| Direct rooms | One-to-ones in the side panel, with earlier chats, search, references, share to room | 01, 19 | Drawn |
| Unread badges | Job tabs and phone job list | 18 | To design |
| To row, Add someone, remove recipient | Composer "To: <job>", `@name`; Add someone on a one-to-one | 01 | Drawn (partly) |
| Plan first, plan card with Open in Score | Ask-me-before "The plan starts"; plan card in the room | 10 | To design |
| Attachments (images to agents, up to ~6 MB), upload progress | Composer `+` | 01 | To design |
| Voice input | Composer | — | To design |
| Slash commands `/assign`, `/routine`, `/model` | Composer `/` (Search shows "/ for a command") | 14 | To design |
| Approval cards: Approve / Deny, More: approve for this session, always approve; delivery failed → retry; "answer in Hermes" | Request bubble + More menu + states | 01 | Drawn (partly) |
| `workspace://` file links | Open the file in Workbench | — | To design |
| Edit message → rewind sessions, versions ‹ 2 / 3 › | Same, on your bubbles | — | To design |
| Deleted messages, show / hide | Thread menu | — | To design |
| Save to Knowledge | Save to Library | — | To design |
| Room details: Files in play, Learned here, Also reachable on | Workbench files, agent memory, Connections › Channels | 02, 06, 15 | Folded |
| Room actions: rename, delete, export, share link (read-only snapshot) | Job menu | — | To design |
| Room summaries (summary card, stale marker) | Job capsule and one-to-one titles/summaries | 01 | Folded |
| Context meter + compact | One-to-one and thread header | — | To design |
| Conversation search | Search | 14 | Drawn |
| "From elsewhere": agents' Hermes sessions not started by Score (Telegram etc.) | Search filter + a section under each agent in Team | — | To design |
| Room stage (pets wander, moods, click to @mention) | Dock rings + glow; **stage dropped** | 01 | Owner |
| Coding-agent sub-agent cards | Inside job capsules / thread | — | To design |
| Message streaming, reasoning/tool cards, stall notice | Thread, capsule "working…" line | — | To design |

## Chat-first view (`/u`)

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Separate chat-first shell, admin/user switch, admin-view password | **Removed**: the new shell is the simple one | — | Owner |
| Orchestration status lines and run header in chat | Job capsules and thread | 01, 11 | Folded |

## Tasks

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Kanban board (Planned, Working, In review, Needs you, Done), filters | **Board dropped**; job tabs + states; Search filters | 01 | Owner |
| Task drawer: assignee, reviewer, steps checklist, activity, Approve once, Unblock, Comment, See it in Flow | A job's thread and its header (steps, unblock, comment) | 11 | To design |
| Task attempts page (history of attempts) | Job history in the thread | — | To design |

## Team

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Agent cards | Team | 04, 20 | Drawn |
| Add agent: blank or copy an existing agent, appearance, preview of changes | Add an agent | 07 | Drawn (partly: copy-from and preview to add) |
| Import a Hermes profile (with progress) | Add an agent › Bring one in | 07 | Drawn (entry) |
| Overview: summary, reports to, operating rules, details, Danger zone (delete with export) | Agent settings | 06 | To design (danger zone) |
| Todo card (agent's Hermes todo list) | Agent settings and the agent's screen page | — | To design |
| Personality: SOUL.md / AGENTS.md with preview diff and conflict choice | "How builder works" + an editor | 04 | To design |
| Model: model, provider, fallback | Team › Model | 04 | Drawn (fallback to add) |
| Skills: list + hub search | Agent settings › Skills | 06 | Drawn (hub search to design) |
| Memory: list, new, delete | Agent settings › Remembers | 06 | Drawn |
| Tools: tools and helper-agent count; Library tools switch | Agent settings › Can use | 06 | Drawn (helper count to add) |
| Plugins per agent | "Plugins and MCP servers" link | 06 | To design |
| Workspace: file tree, code editor, Markdown preview, git branch/changes, resizable split | Workbench and agent settings › Its computer | 02, 06 | To design |
| Routines: new, Run now, delete | Repeating jobs | 10 | To design |
| Permissions: stricter-than-team rules, Ask first, Never rules | "Asks you first before" + an advanced editor | 04 | Drawn (partly) |
| Channels, History ("coming soon") | Reachable on; Recent work | 06 | Drawn |
| Agent looks: 20 shapes, Cut-out / Ring, eyes follow the pointer, moods | Add an agent shows 4 shapes; **keep all 20 + looks?** | 07 | Owner |
| Pet packs (upload, portraits everywhere, Lively / Calm / Still) | **Keep on Team cards and agent page, or drop?** | — | Owner |
| Coding agents: Claude Code / Codex / agy, install + version check, workspace, permission levels, security password for full access, Codex read acknowledgement | Add an agent › Coding tool | 07 | To design |
| Coding agents: quota bars, floor, personality card, sub-agents, one turn at a time, 30-min stop | Agent settings for a coding agent | — | To design |

## Knowledge → Library

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Notes, `[[links]]`, agent attribution, search | Library | 13 | Drawn |
| Backlinks, properties, history | Library note view | — | To design |
| Upload up to 256 MB, drag and drop, PDF/Word text, keep both / replace | "New note or upload" | 13 | To design |
| Zip: unzip into a folder (preview) or keep as zip | Upload flow | — | To design |
| Files view, folders, export | Library | — | To design |
| Agent access settings | Settings (Library access) + agent "Can use" | 06 | Drawn (partly) |

## Reports → Usage

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Range Today / 7 / 30 days, Export CSV | Range picker, Download CSV | 05 | Drawn |
| Tasks finished, runs, spend | Headline numbers, spend by agent | 05 | Drawn |
| Tasks finished by day, stacked per agent with patterns | Tasks per day (single series in the mockup; **restore per-agent stacking**) | 05 | To design |
| First-time pass rate, median time per task | Usage | — | To design |
| Where each agent's time goes (working / waiting on you / waiting on another agent) | Usage | — | To design |
| By-agent table; Your approvals (count, time) + Review rules | Usage | — | To design |

## Settings

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Models and keys: providers, which agents use them, commands to connect (never a key) | Connections › Model providers | 15 | Drawn |
| Local model endpoint (OpenAI-compatible) | Connections › Model providers | — | To design |
| Tool servers (MCP): add by address or command | Connections | — | To design |
| Messaging channels | Connections › Channels | 15 | Drawn |
| Rules: guardian mode (Guardian first / Always ask / Never ask), Go ahead / Ask me / Never lists, review diff, save for team | System › Team rules + editor | 17 | Drawn (summary; editor to design) |
| Look: Light / Dark / System, style per device vs every device, shared colours | Look | 16 | Drawn (per-device vs shared to add) |
| Agents: Lively / Calm / Still | Look › Motion (Calm / Still; Lively only if pets stay) | 16 | Owner |
| Customizer (sections, preview pages, checks, import / export, undo) | Look › Open the customizer; preview pages updated to the new screens | 16 | To design |
| Ways back from a broken theme (Ctrl+Shift+0, Search "Reset look", `?look=safe`, Settings, CLI) | Unchanged | — | Folded |
| Seven built-in themes | Themes row; themes need re-checking against the new layout | 16 | To design |
| Message send key, display currency | Look | — | To design |
| Notifications | Settings | — | To design |
| Knowledge settings | Settings (Library access) | — | To design |
| Shares (read-only room snapshots, revoke) | Settings › Connections or System | — | To design |
| Advanced: every Hermes setting, staged changes, restart hint | System › Advanced | — | To design |
| Backup / restore | System › Backups | 17 | Drawn |
| Logs | System › Logs | 17 | Drawn |
| About: version, service status and command | System › Score | 17 | Drawn |
| Remote access: TLS, paired browsers, revoke, log out | Connections › Your phone (+ details) | 15 | Drawn (partly) |
| Security password, passkeys | Connections › Your phone / System | 15 | To design |
| Terminal: open sessions, close | System › Terminal | — | To design |

## Other pages

| Feature today | In the new design | Mockup | Status |
|---|---|---|---|
| Web terminal (`SCORE_TERMINAL=1`, HTTPS, security password, 15-min idle, max two) | Its own page from Search and Settings | — | To design |
| Pairing page (remote pair) | Restyled | — | To design |
| Pop-out windows | Pop out the side panel (Work, one-to-one, an agent's screen) | — | To design |
| Phone/tablet: menu drawer, one column, section picker, sheets | Tab bar Room · Team · Settings, sheets | 18–20 | Drawn |
| First-run service offer (CLI) | First run step 4 "Keep Score running" | 08 | Drawn |

## Owner decisions this list adds

These join the proposal's §7:

1. Drop the **Score timeline** and the **Flow graph** as views (their information lives in capsules, rings, threads).
2. **Rooms become jobs** in one team room. Do existing rooms migrate to jobs, or stay as separate rooms behind the
   team room?
3. Drop the **Tasks board** (drawer features move into the job thread).
4. Drop the **room stage**. **Pet packs and agent looks**: keep them (Team cards, agent page, glyph portraits), or drop
   them? If they stay, Look keeps **Lively**.
5. Drop the **chat-first view** and the admin-view password.
6. Keep the **workflow graph editor** as an option inside the recipe editor, or make recipes step lists only?
