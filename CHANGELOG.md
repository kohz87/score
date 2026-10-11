# Changelog

All notable changes to Score are listed here. Score follows [Semantic Versioning](https://semver.org/); the format is
based on [Keep a Changelog](https://keepachangelog.com/).

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

[1.0.1]: https://github.com/kohz87/score/releases/tag/v1.0.1
[1.0.0]: https://github.com/kohz87/score/releases/tag/v1.0.0
