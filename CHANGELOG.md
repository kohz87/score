# Changelog

All notable changes to Score are listed here. Score follows [Semantic Versioning](https://semver.org/); the format is
based on [Keep a Changelog](https://keepachangelog.com/).

## [3.2.0] — 2026-10-26

### Added
- **Room tools** for rooms other than the team room (⋯ menu): Rename…, Pin / Unpin (pinned first in the room list),
  Archive / Unarchive (archived rooms hide behind "Show archived"; an open archived room shows a badge with Unarchive),
  Project… (choose, create with a colour, or clear; the list groups by project) and **Export as JSON** (also on the team
  room).
- **Recent runs** on an agent's page: filter by outcome and see each run's cost.

### Fixed
- A room whose messages were all deleted can show them again ("Show deleted messages" appears when something was
  deleted).

## [3.1.0] — 2026-10-26

### Added
- **Team lead** in the team room's ⋯ menu: choose which agent leads (gets unaddressed messages and lead-decides jobs).
- **Usage**: a custom date range and a per-agent table (jobs done, runs, median time, first-time pass, cache hits,
  spend, an "Unknown agent" row); the CSV and the Journey chart follow the range.
- **Agent memory search** on the agent page, with a confirm before forgetting a note.

### Changed
- **The Customizer's Shape options work in the new shell**: corner roundness, borders, shadows, glass (frosted panels)
  and spacing (compact / airy). Decisions and anything holding one always keep a solid fill; built-in themes that set
  these (Harbour: glass; Ledger: sharp corners and strong borders) now look as designed.

### Fixed
- On a phone, the row of agents in the room wraps instead of running off screen (with a large team it made the theme
  safety check switch the theme off).

## [3.0.0] — 2026-10-26

### Removed
- **The classic view.** Score is the new shell only: the classic pages (Chat, Team, Knowledge, Reports, classic
  Settings, classic Watch, the classic terminal page), the "Use the classic view" switch and their styles are gone
  (decision 132). Every old link still opens the right place in the new shell, with its query and anchor.

### Added
- **The Journey chart** (tasks, notes, skills and memory over time) in Settings › Usage.
- **Browser notifications and the "update available" banner** in the new shell (they only ever worked in the classic
  view).
- **Open terminals** are listed and can be closed in Settings › Remote access and security again.
- **Models in pickers** (which models appear in the pickers) in Settings › Connections, and **deleting a routine**.

### Changed
- A task attempt opens inside the new shell (`/b/attempts/…`), with Back.
- The team room opens at its newest message and follows new ones; scrolling up to read stops it, and hover buttons
  no longer make it jump.
- An unchecked Hermes build (approvals paused) is announced across the app, not only in Settings.

### Fixed
- The built-in Harbour theme was switched off on Settings › Look; a shared message's source line could sit unreadable
  on a theme picture; the Settings gear and phone tab were not protected from themes.
- Start a job offered agents being set up, deleted or removed; `/compress` did nothing in a one-to-one; workspace links
  didn't open their file; Usage dropped the "estimated" marker on coding-agent spend; Settings sections didn't open at
  the top; two refusals showed raw wording.

## [2.8.0] — 2026-10-26

### Changed
- **Recipes is its own page** (`/b/recipes`, Recipes in the top bar) with your recipes and saved workflows in one list
  and the editor in the new style: the graph (add, connect, drag, delete, keyboard, undo/redo, preview, the live
  overlay of a running copy, issues), an "As text" step list, step settings, saved versions, duplicate, delete.
  Run opens Start a job with the recipe. Old workflow links open it.
- **Start a job** has the recipe options the old start dialog had, under More options (steps at the same time, an
  estimate per step, most coding steps, quota floor), checked before Start, and says that with a spend cap a step
  whose cost Hermes doesn't report pauses the run.

### Fixed
- The budget, "Ask me before" and More options parts of Start a job are now protected from themes like the rest of it.

## [2.7.0] — 2026-10-26

### Changed
- **The Customizer is part of Settings › Look** in the new style (the last classic settings page). Tabs for Theme,
  Colours, Background, Fonts, Shape, Spacing and Custom CSS; colour groups follow the new screens (ground and panels,
  text, things for you and results, lines, agent screen and code); previews of the Team room, Team, an agent page, an
  agent's screen and Settings. A theme's background picture now shows through the new shell. On a phone the editor
  opens first, with a way back to all settings.
- Dropped with the classic screens: the navigation rail and menu order options, page width, the Chat tab and the Flow
  and Tasks colour groups (older themes keep those values; contrast warnings for them stay, marked "classic view").

## [2.6.0] — 2026-10-26

### Changed
- **Runs live in the side panel** (the last classic run page is gone). Recipe runs and lead-decides runs are listed
  under **Runs**, between Library and Thread; a run opens as its steps, with what each agent did, its status and reply,
  the decisions waiting for you on top, and **Graph** and **Log** tabs, spend, limits and inputs. A lead-decides run
  shows its goal and plan; a recipe run warns when one of its agents was replaced or removed since. On a phone the run
  opens in the side sheet. Old run links open it there.

### Fixed
- A team room whose first read failed no longer loses half-typed fields when it retries.

## [2.5.0] — 2026-10-26

### Changed
- **Watch is now part of the agent's screen page** (the last classic page it used to open). The editor is shown large,
  the terminal and browser as small cards beside it (tap one to swap it in), other screens as chips, and whatever the
  agent asked you stays pinned above its steps. While the agent works, the large screen follows what it is using; your
  pick holds until it moves to another screen. Replay from any step or time, newest steps first with the full history
  on request. Old Watch links open the screen page.

## [2.4.0] — 2026-10-26

### Added
- **Try another reply.** On an agent's finished reply, **Try another** asks it for a different answer to the same
  message. The versions stay together as one message with a pager (‹ 2 / 3 ›); on a phone, swipe it sideways. The
  newest is shown; your pick is remembered on this device. The agent remembers its earlier answers (it says so under the
  message) — nothing is rewound in Hermes. A failed reply keeps **Retry**, and its retry joins the same versions.

## [2.3.1] — 2026-10-26

### Changed
- **A conversation deleted in Hermes is noticed at once** (bridge plugin, `on_session_delete`): Score moves that room's
  agent to a fresh conversation straight away and says so in the room when you deleted it; Hermes' own tidy-up of
  empty conversations is followed silently. Before, Score found out on the next message.
- **Hermes compacting a conversation is logged** in the agent's activity (`post_compaction`).

## [2.3.0] — 2026-10-26

### Added
- **Agents can ask you questions.** When an agent stops to ask something (Hermes' clarify tool), the question shows up
  under Needs you, in the team room, in your one-to-one with that agent and on the dock: answer in writing, pick an
  option, or pick several. Before, the agent waited silently for up to an hour. Answered and ended questions leave a
  short line in the conversation.

### Fixed
- **A conversation deleted in Hermes no longer stalls the room.** Hermes never lets a deleted conversation id be used
  again (also when it tidies up empty ones). Score now starts a fresh conversation for that agent, says so in the room
  and sends your message again once.
- **"Ran out of steps"**: a turn that used up its tool calls keeps its summary and says how to carry on ("continue"),
  instead of "This run failed".
- New Hermes 0.22.5 events (queued, steered, tool progress) are recognised instead of counted as unknown.

## [2.2.0] — 2026-10-26

### Added
- **Agents with eyes** (new shell): every agent glyph has big blank white eyes shaped for its silhouette, and they show
  what the agent is doing: looking around and blinking when idle, flat line eyes when thinking, half-lidded while
  working, big round shocked eyes (and a shake) when it needs you, happy ^ ^ when done, sleepy when paused or offline.
  The big glyph on an agent's page, Add agent and first run follows your pointer and says hi when tapped. Nothing
  moves with reduced motion; the classic shell keeps its eyeless glyphs.
- **Two new shapes**, ball and flower.

## [2.1.3] — 2026-10-26

### Added
- **Terminal icon** beside Settings (when the server's terminal is on): opens the terminal inside the new shell, Back
  returns; Ctrl+` (Cmd+` on a Mac) toggles it, also from inside the shell.
- **Folders in the Library's notes list**: New folder next to New note; folders collapse (with their subfolders), empty
  folders show, a picked folder is where new notes go, "Notes" takes you back to the top level.

### Changed
- **One-line composer placeholders** ("Message the team"); the @/command hint shows while you type and is read by
  screen readers. Long messages grow the box, then scroll.
- **Finished jobs fold** to one row in the team room (Show/Hide); a job stays open while anything in it needs you, is
  pinned, or waits to be sent back.

## [2.1.1] — 2026-10-26

### Fixed
- **Approvals work again with Hermes 0.22.5.** Its session authority sends approval requests with a new id
  (`prompt_id`) and accepts answers only with the run's current execution generation; Score read the old shape, so
  approvals for runs Score started never reached Score after the upgrade. Score now reads both shapes, answers in the
  one Hermes expects, and treats an answer for an older generation as already settled.

## [2.1.0] — 2026-10-26

### Changed
- **Hermes Agent v0.22.5** (the owner's install, main `d778246c`) is a tested build: Score's compatibility check
  passes again, so approvals relay through Score as before. Score's session readers were checked against Hermes's new
  session database layout; Advanced config lists the settings of the new version; three new dangerous-command
  categories are known to Rules (they ask first).
- **Score's agents keep every tool visible**: Hermes 0.22.5's Tool Search (which hides plugin and tool-server tools,
  including Score's own, behind `tool_search`/`tool_call`) is turned off for Score's agents; new agents get the same
  setting when they're set up.

### Fixed
- The composer's **+** menu opened off the left edge of the window in the new shell; it now opens beside the +, fully
  visible (team room, one-to-ones, job threads).

## [2.0.12] — 2026-10-26

### Changed
- **Editing a message no longer asks first**: press Edit, change the text and send. Score rewinds the agents and posts
  the correction by itself. A dialog appears only when it can't: an agent is still working, an agent's session can't
  be rewound, or the room has a live share link (which still shows the old message and can be revoked there).
- **Long lists on an agent's More fold**: memories, skills, tools, plugins, channels and rules show the first few with
  "Show all N"; inputs and decision buttons always stay visible.

## [2.0.11] — 2026-10-25

### Added
- **Message actions everywhere**: Edit (your own messages; the agents rewind to before it), Copy, Save to Library,
  Retry, Pin and Delete now work in one-to-one chats and job threads too, not only in the team room, with the
  versions of an edited message (‹ 2 / 3 ›) and Show deleted.
- **Delete chat** for a chat you started with an agent (undo for 10 seconds), and **Clear chat** for a one-to-one's
  main chat. Both are Score-side: the agent's Hermes session may still remember.
- Deleting a message shows Undo and says when a delete failed.

### Fixed
- Retry is offered on every agent reply to your message (also when two agents answered), not just the first.
- Edit from a job thread on a phone closes the thread and puts the message in the composer.

## [2.0.10] — 2026-10-25

### Added
- **API keys for local models**: the "Add a local model" form takes an optional key, and each local model's row has
  Add key / Change key. The key goes to Hermes for every agent; Score never keeps, logs or shows it. A local model
  shows "Key set" when it has one. An agent that picks a keyed local model without the key is told so.

### Fixed
- The room dropdown's Elsewhere list no longer overlaps when a preview is long: rows grow and the preview stays on one
  line (the full title shows on hover).
- The Library on desktop: the notes list sits beside the note; Backlinks, Links, Properties and History form a column
  beside a wide panel, or a two-column grid under the note on a narrower one; the editor toolbar wraps.

## [2.0.8] — 2026-10-25

### Added
- **Reuse a removed agent's name**: Add agent says the name belonged to a removed agent and asks you to tick "Use the
  name … again" (its old messages, runs and reports keep the name). The new agent starts fresh.
- **A stopped setup or removal shows on the agent page** with Retry or Confirm right there, and the Remove panel shows
  the stopped step instead of a greyed-out button.

### Changed
- **More on the agent page** is a grid of compact cards in the new design (Remembers, Skills, Can use, Workspace,
  Repeating jobs, Delete, then Goes ahead without asking, Never rules, Plugins, Channels, Looks, Name and role, Recent
  runs, Score access, Todo) instead of the old tabs.
- Pause/Resume is hidden while an agent is being set up or removed.

### Fixed
- Removing an agent clears its pause, so an agent of the same name doesn't start paused.

## [2.0.5] — 2026-10-25

### Changed
- **Remove agent…** opens a removal panel right on the agent page, in the new design: what's still going, any reason
  Hermes can't remove it yet, where the private copy goes, then the agent's name to confirm and the removal's progress.
  Coding agents get the same panel. (2.0.3 only jumped to the old Danger zone.)

### Fixed
- The agent page no longer runs off the right edge of a phone screen.

## [2.0.4] — 2026-10-25

### Fixed
- Settings › Tools no longer offers to remove `score`, Score's own tool server: agents reach Score through it. Revoke
  one agent's access on its page instead.

## [2.0.3] — 2026-10-25

### Added
- **Remove a connection** in Settings › Connections and Tools: a model provider (a local one leaves every agent's
  Hermes profile; a hosted one loses its stored sign-in or key), a tool server, or a messaging channel. Each asks first,
  runs through Hermes's own commands, and checks Hermes afterwards. A provider an agent still uses is refused, naming the
  agents. Channels and tool servers drop out of a running gateway when it restarts.
- **Remove agent…** on the agent page takes you to its delete step.
- **The v1 pages inside the new shell**: workflows, run pages, Watch and the Customizer open under `/b` with the new
  shell around them; old links (including `/chat/<room>`, with any `#anchor`) redirect. Recipes shows each recipe's last
  run instead of linking to the old runs list.

### Changed
- **A local model provider (LM Studio, Ollama, …) added in Score reaches every agent**: it is copied into each agent's
  Hermes profile, and picking its model for an agent copies it there first, instead of refusing.
- Agent pages show Hermes's own reason when a change is refused.

### Fixed
- Settings › Rules was dark on dark in the dark look; the Watch approval bar was unreadable in dark and under a theme
  that fails contrast.

## [2.0.1] — 2026-10-25

### Fixed
- **Add an agent** says why it can't add one (the server's blockers and any missing field), instead of a greyed-out
  button. Live servers need `SCORE_BRIDGE_INSTALL_URL` and `SCORE_BRIDGE_INSTALL_REF` (docs/SETUP.md) to create agents.
- **Coding agents are in the team room** and can be its lead; the room's members follow the team as agents are added,
  become ready or are removed (a removed lead is unseated and its queued turns end).
- **Recipes** no longer shows the first-run page through its backdrop while the team room has no lead.
- **Pair another device** explains why it's off (type the security password, or set one first; `scripts/score pair`
  needs neither).

## [2.0.0] — 2026-10-25

The new Score: one team room instead of separate destinations. Built in Phase 11 (docs/PLAN.md); the old pages that the
new shell replaces are gone.

### Added
- **The team room** (`/b`, now the default): every agent in one room, work split into **jobs** with their own tabs,
  threads and sessions. Agents hand work on with **exchanges** (ask, review, hand off, approve, send back) instead of
  @mentions, within turn budgets, job turn limits and spend caps; when one is reached the job pauses and asks you.
- **Needs you**: one protected strip in the room for everything waiting on you — approvals, paused exchanges, a lead's
  question, run safety (quota, spend, unconfirmed ends), report-back, blocked Hermes tasks and the "starting work is
  blocked" review — with a count on the phone's Room tab and announcements for screen readers.
- **A job's thread**, **Results** (what each job made) and the **Workbench** (files with who wrote each line, review
  notes, an agent's screen as an event replay).
- **One-to-ones** with each agent (private by default; share a message to a job, add someone, take a thread aside).
- **Start a job** with a recipe, limits and checks; **recipe editor**; **Library**; **Search** (jobs, messages, notes,
  commands, settings, routines).
- **Team** and **agent pages** (how it works, where it runs — this machine, Docker or SSH — with an honest "separated"
  label), **Add an agent**, **Settings** (connections, look, notifications, system, usage, team rules, security).
- **Webhook triggers** that start jobs from other apps (signed calls; each trigger's jobs start with a $5 spend cap,
  at most 10 open and 100 a day) and **report-back** of a job's result to where it came from.
- **Job menu**: rename, close and reopen, delete with undo, share a read-only link, export.
- **Phone layout**: a job list, full-screen job chats, sheets, a tab bar.
- **Themes** on the new shell, with the protected layer and the contrast fallback covering every decision.

### Changed
- `/` opens the new shell. The classic Chat, Team, Library, Reports, Settings, Watch, workflows and orchestration runs
  stay reachable ("Use the classic view"); orchestration runs moved to `/runs/:id`, workflows to `/workflows`, Watch to
  `/watch/:agent` (old links redirect).
- Older rooms and one-to-ones route with exchanges (migration 0086).
- Agents are colour + shape everywhere; motion is Calm or Still.

### Removed
- The Now page (Score timeline, Flow graph), the Tasks board, the chat-first `/u` view and its admin switch, the room
  stage, pop-out windows, pet packs and portrait looks (Cut-out, Ring, eyes, moods) and Lively motion. Blocked Hermes
  tasks are answered from Needs you; the tasks themselves stay in Hermes.

### Upgrade notes
- Database migrations 0080–0087 run on the first start (rehearsed on a copy of a live database). Back up first.
- The Hermes plugin `score_bridge` gains the exchange tools: update it on each profile and restart the gateway.
- Stored pet packs (`~/.score/packs`) are no longer used.

## [1.14.0] — 2026-10-20

### Added
- **Setup offers the service.** The first `scripts/score start` in a terminal asks whether to run Score as a service
  (starts at boot, restarts after a crash). Yes installs it with the settings you started with; no is remembered and
  `scripts/score service install` does it later. Scripts and anything without a terminal are never asked.
- **Settings › About says whether Score runs as a service**, with the command to turn it on.

### Changed
- **Limits left** (coding agents) is easier to read: each limit is a block with its name and "% left", the bar, and
  the reset time, and the notes sit apart below.

### Fixed
- The launcher only drives the installed service for the data folder it was installed for; commands for any other
  folder (tests, a second home) act on that folder only, and installing or removing the service from another folder is
  refused.

## [1.13.0] — 2026-10-20

### Added
- **Run Score as a service.** `scripts/score service install` installs Score as a systemd user service: it starts at
  boot (with linger) and restarts after a crash (up to 5 times in 5 minutes). Your `SCORE_*` settings and `PATH` are
  kept in a private file (`~/.config/score/score.env`). `service status` and `service uninstall [--purge]` go with it.
  Once installed, `scripts/score start|stop|restart|status|pair|logs` work through the service, and the launcher never
  runs a second copy beside it. New `scripts/score restart` and `scripts/score run` (foreground). See SETUP.md step 9a.

## [1.12.2] — 2026-10-19

### Changed
- **The agent icons next to each room in Chat's sidebar now show who is busy there right now** (a reply in progress,
  or an approval waiting for you), the same as the room stage and its header, instead of everyone who wrote in the
  last 10 minutes. They update live, and only when something changes.
- The stage shows "waiting for you" only while the approval can still be answered (not after Hermes's approvals go
  quiet or are switched off for compatibility).
- **OpenCode is no longer offered** as a coding agent; it was never supported (Claude Code, Codex and Antigravity are).

## [1.12.1] — 2026-10-19

### Fixed
- **A pet pack could vanish.** Score's own test runs (on the same machine) could clear uploaded pet packs from the live
  data folder, so an agent fell back to its mark after the next reload. Tests now never touch the real data folder, and
  Score only tidies its packs and staged ZIPs in the data folder its own database lives in.

## [1.12.0] — 2026-10-19

### Added
- **Room stage.** Under each chat room's title, a strip where the room's members live: agents with a pet pack play it
  (with their mark as a badge), the others are their marks. While resting they wander, stop, and take breaks (coffee,
  stretch, read — whatever the pack has); after 5 quiet minutes they nap. The stage shows what is happening in the room:
  the one writing works, the one that has started but not written yet thinks, the one waiting for your approval steps
  forward with "!", and a hand-off turns the two toward each other. Click a member to @mention it (and see its wave).
  "Hide stage" is remembered per device; Settings › Look › Agents (Lively / Calm / Still) and reduced motion apply; on
  phones up to 5 members show, then "+N".

### Changed
- The room header's status line now says what members are actually doing in the room ("Thinking…", "Working…",
  "Waiting for you"), from the same source as the stage, instead of listing everyone who wrote in the last 10 minutes.

## [1.11.1] — 2026-10-19

### Changed
- Pet avatars (Team card, agent page) stand on a soft shadow under their feet instead of a grey floor band with a line.

## [1.11.0] — 2026-10-19

### Added
- **Agents with a pet pack look like their character everywhere**: in the side list, chat, Now, Tasks, Flow and
  mentions, a round portrait from the top of the idle animation, with a ring in the agent's colour and its mark as a
  badge (at the smallest size, the portrait inside the agent's shape). It plays when you point at it; never under Still
  or reduced motion. The Team card and agent page keep the full animated pet.
- **Upload progress everywhere**: agent import (up to 200 MB), chat attachments (each file), workspace uploads (each
  file) and theme ZIP installs show "Uploading · 42% · 84.0 MB of 200.0 MB", then what the server is doing.
- **Big files in Knowledge**: files up to 256 MB (were 25 MB), ZIPs that unpack to 1 GB. Files over 25 MB are kept and
  downloadable, but not searched or previewed ("Too large to preview (over 25 MB). Download it to open it.").
  Downloads stream from disk.

### Changed
- **A previewed ZIP goes up once**: Knowledge keeps the ZIP it previewed, so Keep, Unzip and an "already exists" retry
  don't send it again (kept for 30 minutes; at most 8 ZIPs, 1 GB).
- **Pet-pack errors name the file**: "luna.zip wasn't accepted:" above the reasons, each reason names the file inside
  it, and an animation that breaks off says where, e.g. "idle.webp: This WebP breaks off: its header says it ends at
  1.8 MB, but the file is 5.1 MB, so only its first 35 frames would play. Export it again."

## [1.10.1] — 2026-10-19

### Changed
- Pet packs can be much bigger: up to **32 MB per animation and 256 MB per pack** (were 8 MB and 64 MB), as a ZIP or
  as files.

## [1.10.0] — 2026-10-19

### Added
- **Agent marks.** Every agent is its shape in its colour, now with 20 shapes (cloud, cylinder, heart, drop, bolt,
  moon, leaf, blob, shield, octagon, bubble and gem join the original eight) and two looks: **Cut-out** (solid, eyes
  cut through; the default) or **Ring** (an outline with solid eyes). Marks breathe and blink at rest, pulse while
  working, look up while thinking and ripple when they need you; their eyes follow your pointer.
- **Pet packs: animated avatars.** On an agent's page (Look, colour and shape › Pet pack), upload a ZIP or the files of
  a pack: looping animations named by activity (`idle`, `work`, `think`, `needs`, `sleep`, and optional `walk`,
  `stretch`, `coffee`, `read`, `greet`, `happy`) as animated WebP, APNG or GIF, plus an optional `pet.json`. The agent's
  Team card and page header play the animation for its mood, with a crossfade; missing activities fall back to `idle`
  with Score's overlays. Point at it for "hi!", click it for a heart. The mark stays as its badge and in lists. "How to
  make a pack" in the panel has the naming table and rules. Upload shows its progress.
- **Settings › Look › Agents:** Lively, Calm or Still (per device; Still also follows reduced motion).

### Security
- Packs are checked from their bytes (type, size, 64–2048 px, the image structure to its end) and ZIPs go through the
  same rules as theme packages; files are stored under activity names only and nothing in a pack is ever run.

## [1.9.5] — 2026-10-19

### Fixed
- Knowledge uploads show their progress: the file, "file 2 of 3", percent and megabytes sent, and what happens after
  ("Checking the zip…", "Unzipping…"). A big zip no longer uploads in silence.
- Uploading at the top level of Knowledge says so ("Added pack.zip at the top level"; the drop hint names the top
  level), so it isn't mistaken for the folder called Knowledge.

## [1.9.4] — 2026-10-19

### Fixed
- Terminal: copying inside **tmux** (and vim or other programs that copy with the standard OSC 52 sequence) now puts
  the text on your clipboard. A program can only do that right after your own key press or mouse release in the
  terminal, never read your clipboard, and "Copied." shows each time. Holding Shift while dragging still selects in
  the browser terminal itself, past tmux.

## [1.9.3] — 2026-10-19

### Fixed
- Terminal: copying works on the LAN address too. Ctrl+C (with text selected), right-click (with text selected) and
  the Copy button copy through the browser's own copy event, which needs no clipboard permission; "Copied." confirms
  it. Before, copying relied on a clipboard permission the browser can refuse on a self-signed address.

## [1.9.2] — 2026-10-19

### Fixed
- Terminal clipboard, the Windows Terminal way: **Ctrl+C copies** when text is selected (and is still the interrupt
  when nothing is), **Ctrl+V or Ctrl+Shift+V pastes**. The key bar has Copy and Paste buttons for the mouse and phones.
  ⌘C/⌘V on a Mac work as before.

## [1.9.1] — 2026-10-19

### Fixed
- Terminal: the security password field sat right against its label; it now has the label above and a full-width field,
  like the other password fields.

## [1.9.0] — 2026-10-19

### Changed
- **Settings is one page per section** instead of one long column: Models and keys, Connections, Rules and approvals,
  Look, Notifications, Knowledge, Shares, Advanced, Backup, Logs, About (plus Remote access and Terminal when they
  apply), each at its own address such as `/settings/logs`. The list on the left is the navigation; on a phone the
  Section picker switches pages. ⌘K finds each section ("Settings: Logs"). Old `/settings#…` links still work.

## [1.8.2] — 2026-10-19

### Fixed
- Themes with a side navigation (Harbour, Dense, Studio, …): the terminal button and your avatar now sit side by side at
  the foot of the rail, and the avatar menu fits inside the rail, so its Light / Dark / System choice is no longer cut
  off.

### Internal
- A coding-process test that failed early under load no longer leaves its fake worker running.

## [1.8.1] — 2026-10-19

Fixes from an overnight cross-audit of 1.8.0 (Codex and Gemini 4 Argon) and a verification pass.

### Fixed
- **More consent screens are protected from themes:** starting an orchestration or a workflow (approval policy, spend
  confirmations, what each coding agent can reach), MCP access, Settings › Remote access (password, pairing, paired
  browsers, passkeys) and the pair page. Each is checked as a whole when you act on it.
- Protection starts the moment a custom theme is on the page, before the theme list has loaded.
- The Customizer has a protected way back to Settings (also on its error page) and the command palette (Ctrl+K).
- A reset you make (Ctrl+Shift+0) before the theme list loads is kept; the chat-first view shows its way back at once.
- **Two windows editing one theme:** pictures and fonts are tied to the theme's version, so a stale window can't mix
  two versions; "Save as new" after a conflict keeps the version you had open, pictures and licence included.
- Import › Replace no longer overwrites a newer save made elsewhere.
- "Save as new" takes its new name and isn't left marked unsaved.
- Saving the theme in use updates other open devices; a replaced picture or font reloads.
- Theme storage: no symlink is followed anywhere on a theme file's path; deleting a theme is journaled and leftover
  folders are swept at start; swaps and rollbacks are flushed to disk in a safe order; a zip entry with extra bytes is
  refused, as in the browser; a theme may be called `constructor`.
- Knowledge: a Git failure no longer reads as "saved to history".
- A failed quota refresh no longer holds work on an old reading.
- A coding agent's personality draft survives a refresh of its settings, with "Reload theirs / Overwrite with mine".
- The Customizer checks chat-first contrast against that view's own background.
- **Chat on phones** keeps the newest lines in view when the context ring appears.

### Internal
- Flaky tests fixed at their causes (Chat phone screenshots, the model picker racing the model-list test).

### Known issues
- A Customizer copy of Paper or Dense differs slightly from the original (corner sizes, Dense's spacing and rail).

### Upgrade notes
- No database migration.

## [1.8.0] — 2026-10-18

Phase 9 is complete: a CMS-style theme system with no theme code running.

### Added
- **Customizer** (Settings › Look › Customize…): build a theme live next to a preview of the real app (any page,
  light or dark, desktop/tablet/phone). Sections for colours (every public colour, in plain words), fonts, shape, layout
  (navigation, width, a menu editor), the Now arrangement, chat, a background picture and custom CSS (with what the
  safety filter dropped). Drag or use the keyboard to reorder; undo and redo; Save, Save as new, Export and Import (an
  install preview before anything changes); **Use on this device** or **for every device**. Live contrast checks name
  every hard-to-read pairing — including text over pictures and glass — and approvals stay readable regardless.
- **Three new built-in themes:** **Harbour** (frosted glass over a dusk harbour, left navigation, chat bubbles),
  **Ledger** (flat, sharp, compact, monospace headlines, one menu button), **Studio** (airy, serif, right navigation,
  Needs you first). The style picker shows every theme in its own colours.
- **Theme author guide** `docs/THEMES.md` and an example theme in `docs/themes/example-theme/`.
- Theme packages may carry their font licence (`LICENSE`, `OFL.txt`); exports keep it.
- **Paper, Night shift and Dense** are full theme packages too, so the Customizer's "Start from" copies them.
- The Customizer saves a theme with a picture or a font in place (no re-import needed).
- **Ways back** from a broken theme: `?look=safe`, Ctrl+Shift+0, the command palette, Settings › Look › Reset and
  `scripts/score look reset` (which also clears each device's own choice, including light/dark). The chat-first view
  has the command palette and its own protected way back.
- User guide sections for Look and themes, the Customizer, the chat-first view, the quota guard and coding agents'
  personality and sub-agents.

### Changed
- **Theme CSS is visual-only** (decision 102): colours, backgrounds, borders, corners, shadows, font family/weight/
  style, underlines and opacity. Anything that moves, sizes, clips, hides, animates or changes text spacing is dropped
  by the Customizer and refused on import, with the reason shown. Layout comes from the theme's options instead.
  Ledger and Studio lost their letter-spacing and line-height tweaks.
- Approvals, answers, permissions, passwords, the Settings link and the ways back are **protected**: a theme can't
  hide, fade, cover, clip or make them unreadable. If one does at the moment you act, Score refuses the action, turns the
  theme off and says nothing was sent. A decision (an approval's request and its buttons, the add-coding-agent form)
  is checked as a whole, every field and label included, and reads in Score's own fonts. Theme CSS can't style text selection or other highlights, and
  agent glyphs and Needs-you dots keep a contrasting plate or edge under a theme.
- Theme menu labels must show something: a blank or invisible label falls back to the destination's own name.
- The browser and the server check theme packages with one shared rule set.
- Saving a theme that is already in use says **Save and apply**: it changes every device that uses it.
- Replacing a theme from a file checks it wasn't changed meanwhile (`If-Match`), so two editors can't overwrite each
  other.
- A theme you installed under the name Harbour, Ledger or Studio is kept as "… (yours)".

### Fixed
- Chat keeps the newest lines in view when the message box finishes laying out after the page loads.
- Watch nests a sub-agent's steps under the right Agent call even when two calls have the same caption.
- Knowledge keeps showing "Save to history again" after a reload until the note really is in history, and says a note
  isn't versioned when Git isn't available.
- Dark mode: Chat's "Start plan" button was white on near-white; the Customizer no longer warns about the main buttons
  of themes with a light dark-mode text colour.
- Replacing or deleting a theme while an interrupted swap is still being recovered is refused instead of mixing two
  versions; so is reading it.

### Internal
- Flaky tests fixed at their causes; a test run that leaves a test agent behind now fails.
- Test workers are capped (`SCORE_TEST_WORKERS`, `SCORE_E2E_WORKERS`, default 4) so parallel runs can't exhaust memory.

### Known issues
- Two editors on the same theme: after one saves new pictures under the same file names, the other's preview and
  "Save as new" can pick up the newer pictures. Fixed in 1.8.1; until then edit a theme in one window at a time.
- A Customizer copy of Paper or Dense differs slightly from the original (corner sizes, Dense's spacing and rail).

### Upgrade notes
- Three database migrations (0075 theme licence files, 0076 theme revisions and the swap journal, 0077 Watch
  sub-agent parents); back up first.

## [1.7.0] — 2026-10-18

### Added
- **Theme layouts (Phase 9, part 2):** a theme can now change Score's whole layout, not only its colours —
  navigation at the **top**, as a **left** or **right** rail, or as a single **launcher** menu button (⌘K stays);
  content width **narrow / wide / full**; the **menu** order, labels and hidden pages (Settings always stays); the
  **Now** cards' arrangement (columns, spans; Needs you is always there); **chat** as bubbles or plain, and the room
  list left, right or hidden until opened; card **elevation**, **glass** surfaces, borders, corner radius and
  density; a **background image** with fit and dim; and separate settings for the chat-first view. Approvals,
  decisions and other protected parts stay solid and readable in every combination. Phones keep a simple top bar.
- **Watch** groups a coding agent's sub-agent steps under "Sub-agent · N steps".
- The chat-first view shows a **workflow header** (title, steps done, Pause, Stop, See full details) and answers a
  workflow's questions in the chat.

### Fixed
- **Coding workers with long home or workspace paths** could fail to start in orchestrations ("policy snapshot larger
  than 4 KB"); the limit is now 64 KB.
- Settings › Look's display-currency fields match the other inputs.
- Unsent text, attachments and recipients in Now's message box survive a theme change.

## [1.6.1] — 2026-10-18

### Changed
- **Agent pages share one cleaner layout** for Hermes and coding agents, following the design: a header with
  **Message** and **Pause/Resume** (Watch and pop-out beside them), consistent gaps between cards, a three-column card
  grid, long lists capped with "Show all N". A coding agent's page has a Personality card with its CLI, workspace and
  quota, then **Limits left**, **Model** and **Access** cards that are edited in place. The limit-floor field is
  left-aligned.

### Fixed
- Cancelling an edit of a coding agent's access no longer keeps the chosen level and the typed security password for a
  later save; a save sends only what changed.
- If pausing an agent partly failed, the retry button repeats the pause instead of offering Resume.
- **Tasks:** choosing two filters quickly (for example Needs you, then a room) no longer drops the first.
- Claude Code 2.1.302 is listed in the coding-worker safety declaration.

### Internal
- Test runs cap their worker processes (`SCORE_TEST_WORKERS`, `SCORE_E2E_WORKERS`, default 4) so parallel runs can't
  exhaust the machine's memory.

## [1.6.0] — 2026-10-17

### Added
- **Themes, part 1 (Phase 9):** Score stores themes and can import and export them as `.zip` packages (`theme.json`,
  sanitised CSS, woff2 fonts, images; no scripts). Settings › Look always shows the style cards; pick a theme for every
  device, or a different one for this device only. Approvals, decisions, password prompts, permission settings, the
  Needs-you items and agent shapes can't be hidden, covered, relabelled or made unreadable by a theme. Ways back from a
  broken theme: `?look=safe`, Ctrl+Shift+0, "Reset look on this device" in the command palette, and
  `scripts/score look reset` on the host. The Customizer and the new layouts follow in the next releases.
- **Sub-agents of coding agents:** a Claude Code turn that used its own sub-agent no longer ends as "not cleanly
  finished"; the sub-agent's steps show nested under its card in Chat and Flow ("Sub-agent · List files · 1 tool call ·
  done"), and Watch marks them.
- **Role and personality for coding agents:** a Personality card on the coding agent's page (role and Markdown
  instructions). Score hands it to the CLI each session (Claude Code as an added system prompt; Codex and Antigravity at
  the start of a session, again only after you change it). Nothing is written into the agent's workspace.

### Changed
- Claude Code **2.1.302** is a tested version.

### Upgrade notes
- Three database migrations (0072 themes, 0073 sub-agent nesting, 0074 coding-agent instructions); back up first.

## [1.5.0] — 2026-10-17

### Added
- **Quota guard for coding agents:** a coding agent whose 5-hour or weekly limit is below its floor (default 10%, set on
  the agent's page or per run) gets no new steps. In an orchestration the lead is told why and picks another agent; if
  it can't, the step waits with "Use it anyway", "Wait until it resets" or "Stop the run" (also in the chat-first
  view). Workflows wait with the same card. Steps already running are never interrupted, and a missing or expired
  reading never blocks. The quota bars mark the floor.

### Changed
- Adding or importing an agent ends on a clear "<name> joined the team" view with Open, Add another and Close, instead
  of a status line under the form.

## [1.4.1] — 2026-10-17

### Fixed
- **Adding an agent with a capital letter in its name** (often added by a phone keyboard) showed "Couldn't read that
  request". The name fields of Add agent and Add coding agent now turn what you type into lowercase, don't
  auto-capitalise, and say "lowercase" in their label; the browser's own check on these fields and on the model name
  works again (its pattern was silently ignored by current browsers).

## [1.4.0] — 2026-10-16

Phase 8: a chat-first view, theme packs, quota meters, a model picker for coding agents and memory notes from compaction.

### Added
- **Chat-first user view** (`/u`): a chatbot-style screen with your rooms and agents in a sidebar, one conversation at a
  time and a large message box. Start an orchestration from chat ("+" or `/orchestrate <goal>`), follow it as short
  status lines between the messages, and answer everything it needs — step approvals, questions, limits — right in the
  chat, with Pause and Stop at the top. Reports, Team and Settings stay in the full (admin) view; switch views from the
  avatar menu. Optionally ask for the security password before this browser opens the admin view (Settings › Look; a
  convenience for a shared screen, not access control).
- **Theme packs** in Settings › Look: Score (default, unchanged), Paper (warm, serif headings), Night shift (deep
  blue-black, navigation on the left) and Dense (neutral, Inter, tight spacing). Each has light and dark variants and
  passes WCAG AA contrast checks; the choice is remembered per browser and applied before the page appears.
- **Usage limits as meters** on each coding agent: Antigravity per model group, Claude Code and Codex from their last
  turn ("as of …"), with % left and reset times in your timezone. No extra CLI calls.
- **Model picker** when you add or edit a coding agent: Antigravity's models from `agy models`, Codex's from its own model
  cache (model fields only), Claude Code's aliases; "CLI default" and "Other…" are always there.
- **Memory notes from compaction:** compacting a room session saves the summary Hermes wrote as a Knowledge note under
  `Memory/<agent>/<year>/<month>/`, with a weight (1–5, default 3) and a monthly index sorted by weight. Notes are never
  overwritten; turn it off in Settings › Knowledge. Only compactions started from Score produce notes (Hermes doesn't
  tell plugins about its own automatic ones).

### Changed
- The avatar in the top bar opens a menu (switch view, theme, log out this browser).
- The Hermes plugin returns the compaction summary (redacted, capped at 32 KB).
- **Antigravity 1.4.0** is a tested version (agy updates itself; checked with a real read-only turn). Its new weekly-only
  "Gemini 4 Argon" limit shows as one meter.

### Fixed
- A long agent description no longer spills over the next lanes on Now or the next entries in the @mention menu: it
  stays on one line, with the full text on hover.

### Upgrade notes
- Two database migrations (0069 quota readings, 0070 the memory-notes setting); back up first as usual.
- Update the Hermes plugin (`hermes_private.py`) on profiles that use Score and restart the gateway while agents are idle.

## [1.3.4] — 2026-10-16

Fixes from two audits of 1.3.2, cross-referenced: a Gemini 4 Argon audit (8 findings, 6 fixed, 2 rejected after checking;
`docs/reviews/2026-10-16-argon-audit.md`) and a fifth external audit (6 findings plus 1 candidate, all fixed;
`docs/reviews/2026-10-16-external-audit-5.md`). Every fix has a regression test that failed before it.

### Fixed
- **Score could freeze all agent work after a restart:** daily journal upkeep dropped the record of a step that was
  stopped before it launched, and the next start then took the journal for truncated. Those records are now kept.
- A settings change that started before you lowered a coding agent's access can no longer raise it back to full access
  without your password.
- After an agent edited a note, two images with the same description and size could swap places. Agents now see
  numbered placeholders like `[image 2: alt, 69 B]`; an ambiguous older edit is refused instead of guessed.
- **Knowledge history status is truthful:** each save reports committed, unchanged, not versioned (ignored folder), Git
  unavailable or failed; a save is never called versioned when Git isn't working; saving unchanged text after a failure
  repairs history, and the editor offers **Save to history again**. Documents, uploads and ZIP imports follow the same
  rules, and wrongly labelled document records are corrected at start.
- A Claude Code or Codex turn that keeps working after its final result no longer counts as completed.
- Shutting down while **Check again** was starting the coding listener could leave the listener running.
- A coding run cut off mid-save could leave a permanent charge on Score's memory budget for coding runs.
- MCP errors now give agents the details they need to retry (for example the current version of a note after a conflict).
- The MCP rate-limit log no longer grows without limit; storage figures for coding steps count every retry.
- Claude Code workers' deny rules name every file tool explicitly (their settings fingerprints change once).
- The Hermes plugin's Knowledge tool descriptions explain the numbered images and the history field.

## [1.3.3] — 2026-10-16

### Changed
- Claude Code **2.1.301** and Antigravity **1.3.6** are tested versions, so agents using them no longer ask you to
  confirm the version (each checked with a real read-only turn; Antigravity on Gemini 4 Argon). To use Gemini 4 Argon,
  set an Antigravity agent's model to `gemini-4-argon-low`, `-medium` or `-high`.

## [1.3.2] — 2026-10-15

Fixes from a fourth external audit of 1.3.1 (seven findings plus one to verify; `docs/reviews/2026-10-15-external-audit-4.md`).
Every fix has a regression test that failed before it.

### Fixed
- Leaving a page while it was refreshing could lose an update and later show old data as current; the page now
  refreshes properly when you come back.
- Upgrading could delete the only record of an unfinished Knowledge move if writing its new copy failed; the old record
  is now kept until the new one is safely on disk.
- **Notes in a folder your `.gitignore` excludes** are saved and now clearly marked **Not kept in history** (badge,
  reason in History, a warning before overwrite or delete). Score never adds them to Git against your rules. When saving
  works but history can't be updated, Score says so instead of hiding it. A note Git already tracks keeps its history
  when its folder later becomes ignored (decision 80).
- A share now keeps the images in its snapshot until the share itself ends, even when the original message is deleted.
- Rejected connections to the coding supervisor socket are closed at once and can't use up its connection slots.
- **Check again** for coding agents now retries starting Score's listener instead of repeating the old error.
- Two simultaneous starts of the same coding turn share one run (not reachable through Score's own callers, fixed anyway).
- Score cleans up its bookkeeping for finished coding runs, so it no longer grows without limit.
- Agents are told that Knowledge writes in ignored folders have no history (Hermes plugin text).

## [1.3.1] — 2026-10-14

### Added
- **Settings › About:** Score's version, build, database schema, contract, Hermes and Node versions, and a **Check for
  updates** button. Score asks GitHub for the list of released versions only when you press it (nothing in the
  background, nothing about you is sent); when a newer version exists it shows the steps to run yourself — Score never
  updates itself (decision 79).
- A coding step waiting for room says so ("waiting for room: other coding steps of this run hold their inputs until they
  are sent or finished"); running workflow steps now show their waiting reason too.

### Fixed
- Four tests that failed only under load now have their real causes fixed (a media fixture that wasn't unique, a fixed
  sleep, the editor's undo grouping by wall clock, and a crash test that watched the wrong process). None was a product
  bug.

## [1.3.0] — 2026-10-14

Stage 3 of coding agents in orchestration (PLAN 7.7c): **workflow steps can be Claude Code or Codex agents.** Design
accepted after two adversarial rounds; Codex code review, a fix round, a verification and a second fix round; every fix
has a regression test that failed before it. Checked live with a real two-step workflow (Claude Code, then Codex).

### Added — coding agents in workflows
- The workflow editor offers Claude Code and Codex agents for step nodes (with their badge); Antigravity
  are shown as unavailable with the reason. **Validate**, saving and starting all report coding problems the same way.
- The run dialog explains in plain words what each coding agent can read and asks for one acknowledgement; it sets the
  coding step limit and which programs may keep going when their cost is unknown. A **rerun asks again**.
- A step's verdict is read only from the CLI's own complete, validated final answer.
- A coding step blocked by changed settings or the step limit keeps its place: **Use the new settings** or **Raise the
  limit** resumes the same try (never a duplicate). **Try again** for a coding step that kept being held back is its
  own small allowance (3), separate from retries. A step whose inputs were withdrawn waits for you instead of hanging.
- The live workflow view shows the CLI badge on coding steps and the new decision cards.
- Workflows without coding agents are unchanged.

### Fixed
- **Coding workers never run with `full` access through "Use the new settings"** (orchestrations too, since 1.2.0): a
  remap to a `full` agent is refused, and a stored `full` policy can't start.
- A restored backup keeps the count of coding Try agains; preflight reserves storage for the concurrency you chose.
- The workflow run dialog says "1 step" (not "1 steps").

## [1.2.1] — 2026-10-14

### Fixed
- An orchestration's coding step no longer overwrites Chat's saved CLI session for that room and agent, so a later Chat
  message there can't resume the step's session (found by the 7.7c design review; 7.7b promised it).

## [1.2.0] — 2026-10-14

Stage 2 of coding agents in orchestration (PLAN 7.7b): an orchestration's lead can give **worker steps to Claude Code
and Codex agents**. Designed over four adversarial reviews, built in three sequential parts, then a Codex code review and
two verification rounds; every fix has a regression test that failed before it.

### Added — coding workers in orchestrations
- Claude Code and Codex agents (read-only or workspace-write) can take worker steps; the lead stays a Hermes agent.
  Antigravity, `full` access and hosts without supervised units aren't workers yet; workflows still refuse coding agents
  (stage 3).
- **The settings you approved are the settings that run.** Starting an orchestration takes a snapshot of each coding
  worker (CLI program, version, permission, workspace, environment fingerprint and the CLI's own config files, by file
  identity only: Score never reads them). Right before a step's CLI starts, Score checks all of it again; anything
  changed holds the step as "Settings changed", with **Use the new settings** to approve the new ones.
- Workers run with the CLI's own extras switched off where the CLI allows it (Codex `--ignore-user-config`,
  `--ignore-rules`; Claude Code `--strict-mcp-config`).
- The start dialog explains in plain words what each worker can read and asks for one acknowledgement.
- A step only starts if the orchestration still allows it at that moment (Stop, pause, deadline, budget, limit); a step
  held back provably never ran and costs nothing. Each retry is a separate try with a fresh CLI session.
- Results are the CLI's own validated final answer, complete up to 32 KB, and only with proof the run ended.
- **Coding step limit** (default 10), counted from the launch journal so restores can't lose it; unknown cost is tracked
  per CLI and can be accepted per CLI.
- Coding steps show a **Claude Code** or **Codex** badge in Flow and the log.

### Changed
- Owed Stops are delivered in the background; shutdown waits up to 5 s for them, the rest stay owed.
- Claude Code 2.1.296 is a tested version.

### Fixed
- Live mode: a coding agent created a moment ago now shows up straight away in rooms and orchestration screens (the
  agent list's cache only knew Hermes profiles and hid coding agents until its next refresh). Found by the live check.
- A refused readiness check in the new-orchestration dialog now blocks Start.

## [1.1.0] — 2026-10-13

Stage 1 of coding agents in orchestration (PLAN 7.7a): every coding turn now runs as its own supervised systemd user
service. Reviewed in seven Codex code reviews and two verification passes; every fix has a regression test that failed
before it.

### Added — coding runs as supervised services
- On hosts where systemd user services work, each Claude Code, Codex or Antigravity turn runs as a transient
  `score-<id>-c-<launch>.service` with a small supervisor. The supervisor talks to Score over a private socket with a
  single-use signed token, starts the CLI only after Score says go, and ends it if Score disappears (watchdog), so a
  crash or restart of Score never leaves a CLI running unseen.
- A turn counts as completed only with proof: the CLI's own success record (validated per CLI), every output line
  received and saved, and the supervisor's final receipt. Anything a CLI sends that Score can't vouch for (an unknown or
  contradictory record, a failure followed by a "success", output lost or cut off) makes the turn fail clearly instead.
- Once a host has run units, coding pauses with a clear note if they stop working, rather than silently falling back.
  Hosts where units never worked keep the 1.0.3 engine.
- A launch journal outside the Score folder records every launch, so a turn is never sent twice, also across crashes,
  restarts and database restores.
- Team › agent shows which engine runs that agent's coding turns.

### Added — installation identity and the freeze
- Each Score folder has an installation identity. A moved folder is confirmed with
  `scripts/score installation confirm-move`, a copy with `confirm-copy`.
- Rare states (a copied folder, a lost or cut-back journal, a database restored over a newer journal) **freeze** all
  agent work: nothing is dispatched, no chat reply or approval goes out, no inherited run is stopped or signalled. Score
  says why, and `scripts/score installation reset-history` (Score stopped; asks first) retires everything unfinished and
  starts a fresh history. Coding runs this Score started itself can still be stopped while frozen.

### Fixed
- Now › Score › Room renders messages as Markdown, like Chat (tables, lists, code).
- A Claude Code `commands_changed` notice (sent by current versions on every turn) is understood.

### Known limitations
- While frozen, Score's own deadline Stop reaches only runs it started in this session; the supervisor's watchdog still
  contains the rest.
- Rolling back both the database and the external journal together to the same older point can't be detected.
- A failed final-receipt sync combined with systemd collecting the unit under the same manager can still be read as a
  clean end.

## [1.0.3] — 2026-10-12

Fixes from a third external audit of 1.0.2 (6 findings; `docs/reviews/2026-10-12-external-audit-3.md`) and from the
adversarial design reviews of 7.7 (coding agents as orchestration workers), several of which found bugs in today's
coding-agent support. Every fix has a regression test that failed before it.

### Fixed — Knowledge
- Moves use one atomic kernel call (`renameat2` with `RENAME_NOREPLACE`): a move can no longer delete a file another
  program put at the destination or lose the original; filesystems that can't do it refuse instead of risking it.
- An interrupted move keeps its plan through errors that can be retried, shows "move pending" on the Knowledge page, and
  is finished only with proof that the destination is the moved file.

### Fixed — coding agents (Claude Code, Codex, Antigravity)
- A run ends as completed only with proof that every process it started is gone; otherwise the reply says tools may
  still be running and that agent waits, with a **Release** action when Score can't tell whose processes they are.
- Stop says what really happened; a failed session resume can't run the CLI twice; a finished run's result is kept and
  retried until saved, also across a restart.
- Signals reach only Score's own processes: kernel-checked group absence, recorded identities, and pidfds (never a
  process number that may have been reused); the CLI dies with Score and starts only after it is recorded; only a
  verified native executable runs.

### Fixed — orchestration journal and locks
- Journal records are written whole with every required sync (file, folder and new parent folders), or the action they
  would permit doesn't happen.
- The journal and the security password use kernel-held locks (never stolen after a crash); the journal can't live
  inside Score's home, and where it lives is recorded outside both, so a restore can't make Score forget work it did.

### Fixed — live data
- A page reopened after it missed updates refreshes before trusting its data; a failed refresh shows an error instead of
  stale data as current.

### Changed
- Coding agents and Knowledge moves now need `python3` (present wherever Hermes runs) for these kernel calls.

## [1.0.2] — 2026-10-11

Fixes from a second external audit of 1.0.1 (27 findings; `docs/reviews/2026-10-11-external-audit-2.md`), each with a
regression test that failed before it, plus the owner's requests since 1.0.1.

### Added
- **New room** works: pick a name, a lead and other agents (it was a placeholder).
- One writing standard for every word in Score (`docs/WRITING.md`): plain, consistent wording across the app, server
  messages and the tools agents read; British spelling; "step", "room", "try", "Knowledge", "access key" throughout.

### Changed
- Agent replies written with "•" bullets show as real, nested lists.
- Adding a coding agent shows a short note about what that CLI can read; Antigravity asks for the read acknowledgement
  only at full access (its sandbox keeps it in its workspace below that).
- Orchestrations and workflows refuse coding agents with a clear message for now (their steps couldn't reach them);
  coding agents as orchestration workers are planned next.

### Fixed — coding agents
- A child process is supervised before anything is recorded, and is stopped if recording fails.
- Stop and the time limit reach tools a CLI left running after it exited; a run ends only when all of them have.
- The model you chose for a turn is the one the CLI runs; Stop before launch means it never starts; a result that
  couldn't be saved is retried instead of left "running".

### Fixed — Knowledge
- Moves, uploads and ZIP imports never replace or delete a file another program wrote meanwhile; a file saved mid-move
  stays where it was; filesystems without hard links are refused instead of risking it.
- Linked Git worktrees work; an interrupted move always finishes on restart, durably recorded first; the move tells you
  which notes still link to the old name.
- ZIP notes get the same checks as saved notes; `.markdown` files become `.md`; an unreadable file is never shown as
  deleted; removed documents are announced; a rebuild keeps Git-tracked documents versioned.
- Links inside code in lists and quotes are left alone, and finding code is linear (large notes no longer stall Score).

### Fixed — everything else
- Workflow step and input names like `constructor` work everywhere.
- The context meter no longer shows "Compacting" forever after a compaction from another browser; page data requests are
  really cancelled when replaced or no longer needed.
- The media check covers the whole store over time; the browser and `scripts/score password` share one lock; a reloaded
  bridge plugin sends what its previous instance had queued; shutdown waits for task-hold recovery.

## [1.0.1] — 2026-10-11

Fixes from an external audit of 1.0.0 (34 findings; report in `docs/reviews/2026-10-11-external-audit.md`). Every fix has
a regression test that failed before it.

### Fixed — data safety
- Media: storage cleanup can no longer delete the file behind a just-uploaded attachment that shares its bytes with an
  evicted one; reads verify the content hash and a sweep re-checks stored files.
- Knowledge: creating or moving a note never replaces a file that appeared meanwhile; link updates during a move apply only
  to the version they were planned from (outside edits are kept); an interrupted move finishes after a restart.
- Workspace: moving a file never deletes a newer version that replaced the original mid-move.

### Fixed — security
- Security password: concurrent changes and host resets are detected (compare-and-swap, re-check after hashing); a
  damaged or unreadable password store fails closed instead of looking unset; failed writes no longer block retries.
- Passkeys are created as discoverable credentials so sign-in can always find them.
- Local mode checks the Host header on every request; workspace path checks treat `.git` in any letter case as protected
  and accept names that merely start with `..`.

### Fixed — reliability
- Live data in the browser: resets while a page is closed, failed first loads, slow or stuck snapshots and long-kept
  handles now recover correctly with bounded buffering and request timeouts.
- Knowledge index: same-size, same-time outside edits are picked up; unreadable folders no longer look like deletions;
  note responses are built from one version; reads are bounded; links inside code examples are left alone.
- Orchestration caches are only updated after a successful save; MCP concurrency slots are held until tools finish;
  shutdown waits for background work before closing the database.
- Bridge outbox: recovery tells a reused process id apart from the original producer, unchanged files are no longer
  rewritten on every append, and directory changes are synced to disk.
- Uploads: text files starting with "PK" are accepted; Office files with unusual ZIP comments are detected; long Unicode
  download names no longer cause an error; files with a NUL byte after the first 8 KB are treated consistently.

## [1.0.0] — 2026-10-11

The first release: a local-first web app for running a team of [Hermes Agent](https://github.com/NousResearch/hermes-agent)
profiles. Tested with Hermes v0.21.x on Linux.

### Now: see the whole team at once
- **Score**, a live timeline with one lane per agent: work in progress, the lead's plan, hand-offs drawn between agents, and
  what is waiting on you.
- **Flow**, the graph of one run (your message and everything it caused), with an inspector, live log and stats.
- **Routines** (Hermes cron jobs): create, pause, run now.
- "Needs you" cards for approvals, gates and questions; **Pause everyone** stops all agents at once.

### Orchestrations and workflows
- **Orchestrations**: give a lead agent a goal; it plans and hands steps to the agents you allow, through Score's own
  orchestrator tools. Approve every step or only what the lead asks, set a budget and deadline, Pause/Stop at any time.
- **Workflows**: draw a pipeline in Flow (agent steps, approval gates, branches on verdict/outcome/output, joins, ends),
  placing nodes freely (drag, snap to grid, arrow keys, or "Arrange automatically"), with live validation, versions and
  scrubbed export; run it with inputs and approvals, and watch it in the layout you drew.
- Both show a **live diagram** with moving dots, a plain-language log and replay at 1×/4×/16×.
- Safety built in: a restore journal kept outside Score's folder, one admission authority, frozen agent mapping with a
  remap decision, honest "not confirmed ended" states, spend shown as provisional unless Hermes proves it.

### Chat
- Rooms and direct conversations; `@mention` hand-offs, `/assign`, `/routine` and other slash commands, Plan first.
- Markdown replies with code blocks, tool cards and thinking; inline approvals; files in play; Stop a reply.
- Message actions: edit, delete, copy, retry; **rewind** (editing or deleting hides the agent's memory of that turn too);
  ChatGPT-style **‹ n / count ›** versions with read-only older branches; "Show deleted messages".
- Room tools: rename, archive, pin, projects, `#tags`, search, export, read-only share links, **delete room**.
- **Context meter** per agent (a ring beside Send) with what is using the context, and **Compact** (Hermes's own
  compressor, through Score's bridge).
- Attach images and documents (PDF, DOCX, XLSX, CSV, HTML, text); room summaries for long rooms; pop-out window per agent.

### Tasks, Team and coding agents
- **Tasks**: a Kanban board (Planned, Working, In review, Needs you, Done) over Hermes's Kanban, with a drawer for steps,
  activity and approvals; Kanban attempts shown as runs.
- **Team**: every agent's personality (SOUL/AGENTS), model and fallbacks, skills, memory, tools and MCP, plugins, workspace,
  routines, channels, permissions and history; create, clone, import, export and delete agents.
- **Coding agents**: Claude Code, Codex CLI and Antigravity (`agy`) work in rooms next to your Hermes agents, using your
  own login and quota, with read-only / workspace-write / full-access levels, version checks, Stop and Watch.

### Watch, Knowledge, Reports, Settings
- **Watch**: replay what an agent did (terminal, files changed, pages visited) on a scrubbable timeline.
- **Knowledge**: a shared Markdown vault (git-versioned) with an Obsidian-style live editor, toolbar, editable tables and
  images stored inside notes; upload PDFs, Word files and zips (searchable by you and your agents); export notes,
  folders or the whole vault as a zip. Agents read and write notes through knowledge tools and MCP.
- **Reports**: tasks finished per day, where each agent's time goes, approvals, spend, CSV export.
- **Settings**: models and keys (including browser sign-in), connections and messaging, rules and approvals, every Hermes
  setting, look, notifications, Knowledge, backup, logs, remote access.

### Access and platform
- Pairing instead of accounts; remote mode over **HTTPS only** (Score's own certificate authority or Tailscale);
  passkeys and a security password; a **web terminal** behind a second factor.
- Installable on phones (PWA) with notifications; a responsive layout with a menu drawer on phones and tablets.
- An MCP server for agents (read-only by default, per-agent tokens).
- Calm motion for state changes (with anime.js), fully off when your system asks for reduced motion.

### Under the hood
- Contract-first API with zod validation at every edge; Score's own SQLite database with forward-only migrations.
- Hermes is reached only through its CLI, its gateway API and Score's bridge plugin; Score never reads Hermes credential
  files and never writes Hermes databases.
- The Hermes bridge plugin keeps its own protocol version (0.1.0), which Score checks for compatibility; it is not the
  app version.
- Licensed under PolyForm Noncommercial 1.0.0; commercial licences on request ([COMMERCIAL.md](COMMERCIAL.md)).

[1.0.3]: https://github.com/kohz87/score/releases/tag/v1.0.3
[1.0.2]: https://github.com/kohz87/score/releases/tag/v1.0.2
[1.0.1]: https://github.com/kohz87/score/releases/tag/v1.0.1
[1.0.0]: https://github.com/kohz87/score/releases/tag/v1.0.0
