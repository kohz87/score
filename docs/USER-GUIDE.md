# Score user guide

This guide walks through the destinations along the top of Score: **Now, Chat, Tasks, Team, Knowledge, Reports, Settings**
(plus the optional **Terminal**).
For installing and starting Score, see the [README](../README.md). The examples use the demo team (`lead`,
`builder`, `reviewer`, `designer`); your own agents will show up under their own names.

## Ideas that appear everywhere

- **Agents.** Each agent is a Hermes profile. Score shows every agent with a color and a shape, never color alone, so
  you can tell them apart in a black-and-white screenshot. You choose them on the agent's page (Team).
- **Needs you.** Anything an agent cannot do alone, such as a command that needs approval, is marked "Needs you" or
  "Waiting on you" and shown in a dark card. The top-level Needs you filter in Tasks and the Now page both surface it.
- **Pairing.** Looking is free; changing needs a paired browser (README, "Pairing"). If a button answers "Pair this
  browser using the link in the server terminal", that is why.
- **What Score never does.** It never reads `~/.hermes/.env`, `auth.json` or any other credential file; it never
  asks you for an API key (it shows the command to run in your own terminal instead); it never writes Hermes
  databases (it reads them read-only and changes things only through the `hermes` command and the gateway API);
  and the only Hermes files it edits are an agent's `SOUL.md` and `AGENTS.md`, with a preview and a conflict check.
  Text that comes from agents' tools is scrubbed of secrets before Score stores it.
- **Search or run a command** (top right, or Ctrl+K / Cmd+K) jumps to any destination by name.

## Now

The home page. The big headline sums up the moment ("Two agents are working. One thing needs you."). Three views
sit next to **Pause everyone**.

### Score (the timeline)

One row per agent, time running left to right, with a "Now" marker. Each block is a piece of work:

- a solid filled block is **working now**; a pale one is **done**;
- a dashed block to the right of the marker is **planned** (by the lead);
- a dark block says **Waiting on you**: that agent is blocked on your decision;
- thin connecting lines are **hand-offs** (work passed to another agent), including review and "sent back".

Below the timeline are three cards:

- **Thread** shows the latest messages in the room that is active. **Open in Chat** continues there.
- **"<agent> is asking"** is the approval waiting for you, with the command shown. **Approve** allows it once,
  **Deny** refuses it, and **Always allow this for <agent>** creates a standing rule for that agent. When nothing
  is waiting, this card says so.
- **Made today** lists what the team finished (files changed, checks passed).

The message box at the bottom sends a message to the room: **To** picks who gets it (default: the room's lead),
**Add someone** adds more agents, **Plan first** asks for a plan before work starts, and the paperclip attaches
files. Attached images are sent to the agents you address (up to about 6 MB per message).

**Pause everyone** stops every running agent at once; the button becomes **Resume everyone**.

### Flow

A graph of one run: a run is one of your messages plus everything it caused (steps, hand-offs, reviews). Pick the
run from the drop-down (Active and Recent). Click a step to see it on the right: who is doing it, what state it is
in, its checklist, the model and tools used and how long it has been running. If the step is waiting for approval,
the approval buttons are right there. **Stop this step** cancels it; **Open in Chat** goes to the room; **Pause
run** / **Resume run** controls the whole run. Below the graph are a live log of what agents are doing and a few
numbers (steps, hand-offs, time, spend when known). If no run exists yet: "No runs yet. Send a message to a room and
the work it causes shows up here."

### Orchestrations

An orchestration is a run where a **lead agent** plans a goal and hands the steps to other agents. Start one with
**New orchestration** (in Chat or in Flow): write the **Goal**, choose the lead, tick the **agents the lead may hand
work to**, and pick when you want to be asked: **Ask me before each step**, **Ask only when the lead asks** or **Never
ask**. An optional budget and deadline sit there too, and **Limits and estimates** holds the finer settings. The list
under **Before it starts** shows the checks Score runs first; tick the acknowledgement (Score controls the work it
starts and can stop it, but agents may still use other tools and start background work Score cannot see) and start.

The run page shows the live diagram, a log of every request the lead made, the plan, and the budget and limits. A
step that needs you appears as a card with its approval buttons; **Pause** and **Stop** control the whole run. A
stopped step whose end Score could not confirm is flagged "Not confirmed ended" and waits for your decision.

### Workflows

A workflow is a **fixed graph** you draw yourself, instead of a lead agent planning on the fly. Open **Flow ›
Workflows** (the **Runs | Workflows** switch at the top of Flow) to see your saved workflows; **a new one** starts an
empty drawing.

- **Editor.** Click an item in the left panel to add it after the selected node (or drag it onto the canvas); dropping
  on a node connects the new one after it. Items are your **agents** (an agent step does work from an instruction) and
  the flow controls below. Select a node to edit it on the right: title, agent, instruction, retries and what happens on
  failure. An instruction can read earlier results with `{{nodes.<id>.output}}`, `{{nodes.<id>.verdict}}` or a run
  input with `{{inputs.<name>}}`. Nodes are arranged for you; the outline under the canvas lists the same graph as
  text. **Undo** and **Redo** work as you expect.
- **Live checking.** A badge above the canvas says "Looks good" or "n problems to fix", the **Problems** list explains
  each one in plain words and clicking it selects the node, and a node with a problem is marked on the canvas. Only
  errors block saving or running.
- **Gates.** A **Gate** stops the run until you approve or reject. Approving follows its approved path; rejecting
  follows a rejection path if you drew one, otherwise stops the run.
- **Branches.** A **Branch** sends the run down one path by a rule on an earlier agent step: its verdict (*passed* or
  *changes requested*), its outcome (*succeeded* or *failed*) or whether its output contains some text. Every branch
  needs a default path. A verdict only exists when the agent's reply ends with a `score-verdict` block; without one the
  default path is taken. A **Join** waits for all of its inputs, and an **End** closes a path.
- **Retries.** Each agent step can retry 0 to 2 times, and can either route a failure to a repair path or fail the run.
- **Saving.** **Save as new version** never overwrites: saved versions are fixed, and a run keeps the version it
  started with. If someone else saved first you are told, and you can start from an older version. **Export** gives a
  scrubbed copy of a saved version (agents travel as name and role); it shows what the scrubber changed and lets you
  leave fields out. There is no import yet.
- **Running.** **Run…** (in the editor, or **Run a workflow** in Flow) asks for the run's inputs, the approvals
  (**Ask me only at gates** or **Ask me before every agent step, too**), an optional budget and deadline, what to do
  when Hermes does not say what a step cost (**Pause the run and ask me** or **Keep going**) and which agents the run
  will use. It also shows the checks that run first and the same acknowledgement as an orchestration, which you tick to
  start. Running needs a saved version.
- **The run.** The run page is the live diagram (diamond: a gate that waits for you; hexagon: a branch), a log in plain
  words and, below, the budget and limits. Click a node to filter the log and see its details. When it needs you there
  is a card at the top: a **gate** (with the exact text and the Approve and Reject buttons); **Retry** for a step you
  abandoned, which runs it again while attempts are left; **Try again** when Hermes has refused a step 20 times, which
  asks Hermes once more (or stop the run); and **Remap** when an agent the run used has been replaced, which keeps
  its steps blocked until you choose to continue with the new agent (the card lists the steps it will affect). A run
  can also be paused or stopped, and finished runs replay on the same diagram.
- **Honest spend.** Hermes usually reports tokens but not dollars, so Score does not claim a settled cost: the budget
  block says "spend not settled" and keeps the reserved amount until the run ends. Unknown cost never counts as zero.

### Routines

A read-only list of every agent's scheduled routines and when each last ran. Create and edit them on the agent's
page (Team, Routines tab) or with `/routine` in Chat.

### Watch

Watch replays what one agent did: its terminal (commands and the end of their output), the files it changed (as diffs)
and the pages it looked at (with screenshots when the agent captured one). It is a replay of recorded events, not a remote
view of a screen.

- **Live**: the stage follows the agent as it works; a banner says you're watching and the agent is in control.
- **Timeline**: markers for commands, file edits, browser pages and approvals. Click or drag back to replay any moment,
  use the arrow keys to step, and **Live** to return. The agent keeps working while you look at the past.
- **Approval bar**: when the agent is waiting for you, approve or deny right there.
- **What they're doing** lists the latest steps; **Other screens** shows what the other agents last had in front.
- **Pause <agent>** stops new work after the current step (blocked tasks are released on Resume). **Open in terminal**
  copies `hermes -p <agent> --resume <session>` so you can continue the same session yourself. Score never takes
  control of an agent's session.
- Secrets are redacted twice before anything is stored, and nothing from password-vault tools is ever recorded.

## Chat

Conversations with your team. The list on the left has **Rooms** (several agents together) and **Direct**
(one-to-one with an agent); a badge counts unread messages.

- **Writing.** Type in the box at the bottom. Mention an agent with `@name` to hand work to them; the "To" row
  shows who will receive the message ("Unaddressed messages go to <lead>" tells you the default). Add or remove
  recipients with **Add someone** and the small x on each chip. **Plan first** asks the team to lay out a plan (shown as a plan card)
  before doing the work. Attach files with the paperclip.
- **Slash commands.** Typing `/` opens a menu: `/assign @agent <title> [-- body]` creates a task,
  `/routine @agent <schedule> <prompt>` a scheduled routine, and `/model <model> <message>` uses a different
  model for one message. Memory and skills are managed on the agent's Team page.
- **Approvals in the thread.** When an agent needs permission, an approval card appears in the conversation with
  **Approve** and **Deny**. **More** offers **Approve for this session** and **Always approve** where Hermes allows
  them. If delivery to Hermes fails, the card says so and you can try again. Some approvals can only be answered
  inside Hermes; the card says that too.
- **File links.** A reply can link to a file in an agent's workspace with `[main](workspace://src/main.ts)` (the file
  belongs to the agent who wrote it) or `[main](workspace://builder/src/main.ts)` (a named agent). Clicking it opens
  the file in that agent's Team › Workspace tab. Tell an agent to write file references this way. A path that is not
  allowed shows the same error as in the Workspace.
- **Message versions.** **Edit** on one of your messages puts its text in the box; sending the correction rewinds the
  agents' sessions in this room to before that message and hides the old message and everything after it as a previous
  version. The corrected message then carries a small **‹ 2 / 3 ›** control: the arrows switch between its versions,
  showing an older one in place, read-only, together with what followed it. Score tells you when an agent's session
  could not be rewound; long-term memory and Knowledge notes are not rewound.
- **Deleted messages.** Deleted messages and previous versions stay out of the way. The room's actions menu has **Show
  deleted messages** (and **Hide deleted messages**) to bring them back for this tab, read-only.
- **Save to Knowledge.** Under a message, **Save to Knowledge** saves its attachments or an agent's reply (as a note)
  into a Knowledge folder you choose.
- **Plans.** A plan card shows who will do what on a small timeline, with **Open in Score**.
- **Room details** (the "Show room details" panel): **Files in play** (files agents touched here), **Learned here**
  (facts saved to an agent's memory from this room, with **Open memory**) and **Also reachable on** (messaging
  channels the room is mirrored to; **Manage channels** goes to Settings).

## Tasks

A board of the team's tasks in five columns: **Planned, Working, In review, Needs you, Done**.

- **Filters.** The Room drop-down limits the board to one room; **Needs you** shows only tasks waiting on you;
  an agent button shows only that agent's tasks (press it again to clear). The filters live in the address, so
  you can bookmark or share a filtered view.
- **Cards.** Click a card (or move with the arrow keys and press Enter) to open the drawer.
- **Drawer.** It shows who is assigned, the reviewer, who created it and the room, a checklist of **Steps**, and
  an **Activity** log. For a task waiting on an approval you see the agent's request and **Approve once**. **See it
  in Flow** jumps to the run. A blocked task offers **Unblock**, and you can leave a **Comment** for the agent.
  Escape closes the drawer.
- **New task** is greyed out ("coming soon"). Create tasks with `/assign` in Chat for now.

## Team

Your agents at a glance, with a card for each. **Add agent** creates a new Hermes profile: choose a name, whether
to start blank or copy an existing agent, and an appearance; Score shows a preview of every change and then runs
it. This needs the bridge install settings described in the README ("Create and manage agents").

Click an agent to open its page. It has an appearance picker (color and shape) and these tabs (the Workspace tab also has its own address, `/team/<agent>/workspace?path=<file>`):

- **Overview**: a short summary of personality, who it reports to, where it works, its operating rules, the model
  and skills it uses and its routines, plus **Agent details** (display name, description) and a **Danger zone**
  with **Delete agent** (you type its name to confirm, and a private export is kept first).
- **Todo** card (Overview, and on Now while the agent works): the agent's own Hermes todo list with each item's state,
  read-only. It appears once the agent has used its todo tool.
- **Personality**: edits the agent's `SOUL.md` (who it is) and `AGENTS.md` (standing rules). **Preview changes**
  shows the exact difference before anything is written. If the file changed meanwhile, you see the other version
  and choose **Reload theirs** or **Overwrite with mine**.
- **Model**: the model the agent uses, the provider behind it and the fallback; **Change model** switches it.
- **Skills**: skills the agent has, and a search of the skills hub to add more.
- **Memory**: facts the agent remembers; **New memory** adds one, and each entry can be deleted.
- **Tools**: the tools it can use and how many helper agents it may spawn.
- **Workspace**: the agent's working folder. Files open in a code editor with colours for Markdown, JavaScript,
  TypeScript, JSON, CSS and HTML (other files are plain text); Markdown files have a **Preview** switch. When the
  folder is inside a git repository the header shows the branch and how many files changed (Score only reads git,
  it never commits). Drag the bar between the file list and the editor, or focus it and use the arrow keys, to
  change the width; Score remembers it in this browser.
- **Routines**: scheduled work. **New routine** takes a schedule and a prompt; each routine has **Run now** and a
  confirmed delete.
- **Permissions**: this agent's rules on top of the team rules (see Settings). An agent can be made stricter than
  the team, never looser. **Ask first** makes a kind of command always ask; **Add Never rule** blocks commands
  that match some text.
- **Channels** and **History** say "coming soon".

### Coding agents

**Add agent** also offers **Coding agent**: Claude Code, Codex CLI or Antigravity (`agy`) joins the team next to your Hermes agents, using
your own CLI login and plan quota. Choose the CLI (the form shows whether it is installed and whether its version is
one Score has tested; an untested version needs your confirmation before it runs), a name, a workspace folder (default
`~/score-workspaces/<name>`) and a permission level:

- **Read only**: looks at files, changes nothing;
- **Workspace write**: edits files in its workspace (the default);
- **Full access**: no sandbox, anything it is told runs as your user. Choosing it needs the security password, and
  so does raising an agent to it later (lowering never does).

Antigravity notes: below full access its sandbox keeps reads and writes inside the workspace, and it can't run shell
commands at all at read only or workspace write (no tests or builds); when it refuses an action the reply says
"Antigravity refused: …". Its 5-hour and weekly limits per model group show on the agent card. `agy` updates itself, so
after an update Score asks you to confirm the new version before the next turn.

The level limits what the agent can **change**, not what it can **read**. For Codex the form says so and you must tick
"I understand this Codex agent can read every file my user can, including secrets outside its workspace" before it
is created; Claude Code runs with deny rules for `~/.hermes`, `~/.score`, `~/.ssh` and `.env` files. A coding agent
works in rooms only (@mention it like any other); it cannot take Tasks, and its Hermes-only tabs (skills, memory,
routines and so on) do not apply. One turn runs at a time (others show as queued), a turn is stopped after 30
minutes, and **Stop** works as for other agents.

## Knowledge

A shared folder (the vault, default `~/score-vault`) of Markdown notes and files that you and your agents use. Notes
link to each other (`[[Note]]`), show backlinks, properties and history, and an agent's edits carry its name.

- **Upload.** **Upload** (or **Upload files** in the **Files** view) takes files of up to 25 MB, or drag them onto
  the page or a folder in the tree. Markdown files and `.txt` become notes; PDF, Word (`.docx`), CSV, JSON, HTML and
  images are stored as files. Text is pulled out of PDFs and Word files so search and agents can read it; if that fails
  the file is kept without text. A name that already exists asks whether to keep both or replace it. **New folder**
  creates folders.
- **Zip files.** A zip asks what to do: **Unzip into a folder** (with a preview of the files that will be added or
  skipped) or **Keep as a zip** (stored and downloadable, not searched). Only the allowed file types are unzipped.
- **Save to Knowledge** from Chat (see Chat) puts a message's attachments or an agent's reply into a folder.
- Agents can search and read notes and file text through Score; they cannot upload or delete files. Settings ›
  Knowledge controls agent access, and each agent has a Knowledge tools switch under Team › Tools.

## Reports

How the team is doing over **Today**, **7 days** or **30 days**. A one-line summary sits on top, then:

- the numbers: tasks finished, agent runs, share that passed review the first time, median time per task, model
  spend;
- **Tasks finished, by day**, a stacked bar chart per agent (each agent has its own color and pattern);
- **Where each agent's time goes**: working, waiting on you, waiting on another agent;
- **By agent**: finished, runs, median time, first-time pass;
- **Your approvals**: how many were asked and how long you took, with **Review rules** to change what asks.

**Export CSV** downloads the table for the chosen range. Reports are computed from Score's own records and Hermes
usage data (read-only), so spend appears only when Hermes records a cost.

## Settings

A navigation list on the left, one card per section. Settings for a single agent are on its Team page.

- **Models and keys.** Providers with their status (connected or not) and which agents use them. **Connect** (or
  **Edit**) shows a command for you to run in a terminal; Score never asks for or stores a key or runs a sign-in
  for you. **Add** under Local model registers any OpenAI-compatible endpoint.
- **Connections.** **Tool servers** your agents can use (**Add a tool server** takes an address or command; sign-in
  and fix-up steps are shown as commands to run) and **Messaging** channels.
- **Rules and approvals.** What agents may do alone, what they ask you first, and what they never do. Pick **How
  "Ask me" works**: *Guardian first* (a guardian model reviews risky commands and asks you when unsure), *Always
  ask me*, or *Never ask* (use with care). Then maintain three lists: **Go ahead** (kinds of commands allowed
  without asking), **Ask me**, and **Never** (commands that match some text are always refused). **Review
  changes** shows the difference and **Save for the whole team** applies it. Never rules are guardrails, not a
  security boundary: they match command text and can be bypassed by clever wording, so keep real secrets out of
  reach in other ways.
- **Look.** Choose the theme (Light, Dark or System). Hermes plugins are per agent: turn them on or off in Team › the agent › **Plugins** (the Score bridge stays on; a change applies on the agent's next session).
- **Advanced.** Search every Hermes setting. **Stage change** collects edits in a tray (**Pending changes**); you
  preview the difference, apply, and Score says whether the gateway needs a restart for the change to take effect.
  Changes go through the `hermes` command only.
- **Remote access** (only visible in remote mode): how to set up TLS, the list of **Paired browsers** with a
  revoke button for each, and **Log out this browser**. See the README for pairing and remote mode.

## Terminal

An optional shell on the machine Score runs on, in your browser (**Terminal** in the top bar, or in the menu on
small screens). It is off unless Score was started with `SCORE_TERMINAL=1`, and it works only over **HTTPS** in
remote mode, where the page tells you if it is unavailable and why. Opening one asks for the **security password**,
which must be set on the Score machine with `scripts/score password` (a password set in the browser does not unlock
it); a passkey works too where the browser allows it. The terminal runs as your user, so anyone who can use it can do
anything that account can. It closes after 15 minutes without activity (use tmux for long jobs), at most two are
open at once, and the open ones are listed and can be closed under Settings.

## On a phone or tablet

Below 1024 px wide the top bar turns into a **Menu** button that opens a side drawer with Now (and its Score, Flow and
Routines views), Chat, Tasks, Team, Knowledge, Reports and Settings, plus Terminal when it is on. Pages reflow to one
column and each page opens on its content: in Chat an open room fills the screen and **Conversations** opens the room
list as a drawer (with no room open, the list shows first); Settings has a **Section** picker; Knowledge's note tree is
behind **All notes**; Tasks shows one board column at a time with column tabs above; the Now timeline scrolls sideways
with the agent names pinned. Dialogs open as full-screen sheets on a phone.
