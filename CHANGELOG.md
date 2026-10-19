# Changelog

All notable changes to Score are listed here. Score follows [Semantic Versioning](https://semver.org/); the format is
based on [Keep a Changelog](https://keepachangelog.com/).

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
