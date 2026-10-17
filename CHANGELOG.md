# Changelog

All notable changes to Score are listed here. Score follows [Semantic Versioning](https://semver.org/); the format is
based on [Keep a Changelog](https://keepachangelog.com/).

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
- The workflow editor offers Claude Code and Codex agents for step nodes (with their badge); Antigravity and OpenCode
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
