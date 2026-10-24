# Bold redesign: design sources

Mockups for the UI rework proposed in [`docs/proposals/ui-rework-bold.md`](../../proposals/ui-rework-bold.md).
The live, clickable canvas (owner's account, private): https://claude.ai/artifact/7zF2GJcnzUcArXiWeaRknh

**`prototype.html`** is the whole app as one clickable page (open it in a browser, no build): every screen above plus
the owner decisions of 2026-10-24 (recipe editor, agent page with "Runs on", message actions, room dropdown, job menu,
Rules, Tool servers and webhook triggers, Notifications, Advanced, Security), with working delete and undo. It is a
throwaway mock with fake data; it shows behaviour, not code to reuse. Live copy (owner's account, private):
https://claude.ai/artifact/4PcQUWnmxeswmpaLTCQZoe

The whole app, in four areas: **Room** (the team room and its side panel), **Team**, **Settings** (a gear), and
**Search** (⌘K, from anywhere). The side panel is one dropdown: **Work** (Results / Workbench), **Library**, a job's
**Thread**, or a **one-to-one** with any agent.

| File | Screen |
|---|---|
| `01-team-room.dc.html` | **The main screen.** Team room on the left (always on, jobs as tabs, "needs you" pinned, job capsules, "take it aside"), side panel on the right: Work or a one-to-one (earlier chats, search, references, share to the room). Clickable |
| `02-job-wide.dc.html` | One job opened wide: threaded chat beside **Results / Workbench** (code with each agent's marks, the agent's screen, drafts). Clickable |
| `03-phone-room.dc.html` | A job on a phone: threaded chat, request bubble, typing |
| `04-team.dc.html` | Team: agent cards (state, where its computer is, live screen glimpse, Message), the selected agent's four settings |
| `05-settings-usage.dc.html` | Settings › Usage, which replaces the Reports page |
| `06-agent-settings.dc.html` | Team › builder › everything else: memory, what it can use, skills, channels, recent work, its computer |
| `07-add-agent.dc.html` | Add an agent: new, import a Hermes profile, or a coding CLI; shape + colour (taken colours fade), role, model, where it works |
| `08-first-run.dc.html` | First run: Hermes found, pick the agents, pick the lead, keep Score running |
| `09-empty-room.dc.html` | The team room before the first job: starter recipes, empty Work panel |
| `10-start-job.dc.html` | Start a job: recipe (replaces orchestrations/workflows), repeat (replaces routines), ask-me-before, turn budget, spend cap, save as recipe |
| `11-job-thread.dc.html` | A job's thread by rounds, paused at its turn budget: the exchange asks you to decide; "step in" box |
| `12-agent-screen.dc.html` | An agent's screen, read-only: plain-step log, the screen, time bar with markers, Live (replaces Watch) |
| `13-library.dc.html` | Library in the side panel (replaces Knowledge): notes with who wrote them and which job, search, links |
| `14-search.dc.html` | ⌘K: jobs, one-to-one chats, Library, messages, and actions in one box |
| `15-settings-connections.dc.html` | Settings › Connections: Hermes, model providers, channels, your phone |
| `16-settings-look.dc.html` | Settings › Look: dark (default) / light / match device, motion, text size, themes |
| `17-settings-system.dc.html` | Settings › System: team rules (go / ask / never), Score service and updates, backups, logs, pause everyone |
| `18-phone-jobs.dc.html` | Phone: the team room as a job list with the pinned request; tab bar Room · Team · Settings |
| `19-phone-one-to-one.dc.html` | Phone: a one-to-one in the agent's colour, earlier chats, a reference chip |
| `20-phone-team.dc.html` | Phone: team list with state and Message |
| `21-room-dropdown.dc.html` | The room dropdown: the team room, older rooms carried over, and **Elsewhere** (agents' Telegram, terminal and scheduled chats, read-only, "Bring into a job") |

These are `.dc.html` design-canvas files: plain HTML with **inline styles**, plus `<sc-if>` / `<sc-for>` / `{{ }}`
template tags and a small `class Component` script for the clickable states. They do not open standalone (they need
the canvas runtime). Read them as the source of truth for layout, copy, colours, radii and spacing, as AGENTS.md
says of `docs/design/html/`. Sample data in them (numbers, file names, messages) is illustrative.

## Visual system used in the mockups

- **Dark first.** Ground `#12131A`; raised panels `#1A1C23`; inner fields and agent bubbles `#23252E`; hairlines
  `#2C2F38`. Text `#ECEEF1`, secondary `#C9CCD4`, muted `#A9ADB8`.
- **Light objects mean "this is for you or it is the result".** Your messages, requests that need you (approvals,
  questions) and result cards are light (`#ECEEF1` / `#FFFFFF`) with ink `#12131A` text and ink buttons.
- **Agents are colour + shape** (AgentGlyph): lead violet circle `#6B4EFF`, builder jade triangle `#19C39A`, reviewer
  saffron diamond `#FFB61E`, designer coral rounded square `#FF6B8A`. On dark, agent name text uses the light tints
  `#B3A6FF`, `#5EE3BF`, `#FFC94D`, `#FF97AE`. A working agent glows in its colour (Score's halo tokens).
- **Charts on dark** use deeper agent tones that pass the palette validator (lightness band, CVD separation,
  contrast vs `#1A1C23`): lead `#7A61FF`, builder `#14A985`, reviewer `#C08A10`, designer `#E85A7A`. Every bar is
  also labelled with the agent's name and shape.
- **Type:** Bricolage Grotesque (headings, big numbers), Hanken Grotesk (body), JetBrains Mono (code, commands).
  The mockups load them from Google Fonts; the app must keep using `@fontsource`.
- **Shape:** pills (`999px`) for buttons and chips, `20–30px` radii for cards and panels, 44px minimum touch targets.
- Reduced motion turns off every animation (glows, typing dots, live dots).
