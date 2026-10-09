# Score user guide

This guide walks through the six destinations along the top of Score: **Now, Chat, Tasks, Team, Reports, Settings**.
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

Click an agent to open its page. It has an appearance picker (color and shape) and these tabs:

- **Overview**: a short summary of personality, who it reports to, where it works, its operating rules, the model
  and skills it uses and its routines, plus **Agent details** (display name, description) and a **Danger zone**
  with **Delete agent** (you type its name to confirm, and a private export is kept first).
- **Personality**: edits the agent's `SOUL.md` (who it is) and `AGENTS.md` (standing rules). **Preview changes**
  shows the exact difference before anything is written. If the file changed meanwhile, you see the other version
  and choose **Reload theirs** or **Overwrite with mine**.
- **Model**: the model the agent uses, the provider behind it and the fallback; **Change model** switches it.
- **Skills**: skills the agent has, and a search of the skills hub to add more.
- **Memory**: facts the agent remembers; **New memory** adds one, and each entry can be deleted.
- **Tools**: the tools it can use and how many helper agents it may spawn.
- **Routines**: scheduled work. **New routine** takes a schedule and a prompt; each routine has **Run now** and a
  confirmed delete.
- **Permissions**: this agent's rules on top of the team rules (see Settings). An agent can be made stricter than
  the team, never looser. **Ask first** makes a kind of command always ask; **Add Never rule** blocks commands
  that match some text.
- **Channels** and **History** say "coming soon".

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
