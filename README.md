# Score

Score is a local-first web app for running a team of [Hermes Agent](https://github.com/NousResearch/hermes-agent)
profiles. A room brings the team's work together, agents hand work to each other with `@mentions`, and anything that
needs your decision (an approval, a review) waits for you in one place.
It runs on your machine, keeps its own data in `~/.score`, and talks to Hermes through the `hermes` CLI and the
gateway API. It never reads your Hermes credential files and never writes Hermes databases.

![Score's team room: job tabs, a card that needs you, the conversation and the Results panel](docs/screenshots/team-room.png)

(The screenshots show the built-in demo team: `lead`, `builder`, `reviewer`, `designer`.)

## Requirements

- Linux (tested on Ubuntu 26.04, x86_64), `git`, `curl`, `tar`, `xz`.
- **Node.js 24** and **pnpm 12**. Coding agents and Library moves also use `python3` (3.9 or newer).
- For real agents: [Hermes Agent](https://github.com/NousResearch/hermes-agent), tested with **v0.22.5**. Without
  Hermes, Score runs a demo team (`SCORE_MODE=fake`) that calls no model.
- A browser. Score serves its own web app; nothing is loaded from a CDN at runtime.

## Setup

Score runs on Linux (tested on Ubuntu 26.04, x86_64). Every step below installs into your home folder unless it says
**sudo**. Steps 1–2 give you the demo (no Hermes, no model calls); steps 3–6 connect your real Hermes agents.

### 1. Prerequisites

You need `git`, `curl`, `tar` and `xz`, plus **Node.js 24** and **pnpm 12**. Coding agents and Library moves also use
`python3` (3.9 or newer, already there wherever Hermes runs) for two kernel calls Node can't make. Node without sudo:

```bash
V=v24.21.0; D=node-$V-linux-x64
mkdir -p ~/.cache ~/.local/opt ~/.local/bin && cd ~/.cache
curl -fsSLO https://nodejs.org/dist/$V/$D.tar.xz
curl -fsSL https://nodejs.org/dist/$V/SHASUMS256.txt | grep " $D.tar.xz\$" | sha256sum -c -
tar -xJf $D.tar.xz -C ~/.local/opt && rm $D.tar.xz
for b in node npm npx corepack; do ln -sf ~/.local/opt/$D/bin/$b ~/.local/bin/$b; done
corepack enable --install-directory ~/.local/bin
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
node -v && pnpm -v          # v24.21.0 and 12.9.1
```

`~/.local/bin` must be on your `PATH` (it is on Ubuntu once the folder exists; log out and in if `node` isn't found).
nvm, fnm or mise work too (the repo has a `.node-version`). Optional extras:

- **uv** (only to run the bridge plugin's tests): [docs/SETUP.md](docs/SETUP.md) §1c.
- **Web terminal**: needs a C++ toolchain, **sudo** `apt install build-essential python3`, then `pnpm rebuild node-pty`.

### 2. Get Score and try the demo

```bash
git clone <repo-url> ~/score && cd ~/score
pnpm install
pnpm build
pnpm start                  # http://127.0.0.1:8740 with a built-in demo team; Ctrl+C stops it
```

The terminal prints a one-time **pairing link** (`Pair this browser: …/pair#…`). Open it once in your browser; until a
browser is paired you can look around but not change anything (see [Pairing](#pairing)). `pnpm dev` runs the same
demo with live reload for development (web on port 5173).

### 3. Install Hermes Agent

Skip this if Hermes already runs on this machine. Install it with Hermes's own installer, then run its setup wizard
(model provider, keys) and start its gateway:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup
hermes gateway start
```

Score is tested with Hermes **v0.22.5**. More in the [Hermes Agent README](https://github.com/NousResearch/hermes-agent).

### 4. Connect Score to Hermes

1. **Give Score an API key for each Hermes profile** (Score keeps its copies in `~/.score/hermes-keys/`, mode 0600). These
   commands change Hermes's config and restart its gateway — read them first:

   ```bash
   umask 077; mkdir -p ~/.score/hermes-keys
   python3 -I -c 'import secrets;print(secrets.token_urlsafe(32))' > ~/.score/hermes-keys/default
   hermes config set API_SERVER_KEY "$(cat ~/.score/hermes-keys/default)"
   hermes gateway restart
   # every other profile Score should drive (replace <profile>):
   python3 -I -c 'import secrets;print(secrets.token_urlsafe(32))' > ~/.score/hermes-keys/<profile>
   hermes -p <profile> config set API_SERVER_KEY "$(cat ~/.score/hermes-keys/<profile>)"
   ```

2. **Install the Score bridge plugin** into each profile (it reports activity to Score and powers approvals, rewind,
   compact and the context meter):

   ```bash
   ln -s ~/score/hermes-plugin/score_bridge "<profile home>/plugins/score-bridge"   # default profile home: ~/.hermes
   hermes -p <profile> plugins enable score-bridge
   hermes gateway restart
   ```

3. **To create agents from Score** (Team › Add agent), tell Score where to install the plugin from, pinned to a commit:

   ```bash
   export SCORE_BRIDGE_INSTALL_URL="file://$HOME/score#hermes-plugin/score_bridge"
   export SCORE_BRIDGE_INSTALL_REF="$(git -C ~/score rev-parse HEAD)"
   ```

### 5. Run Score with your agents

```bash
SCORE_MODE=live scripts/score start    # runs in the background and prints a pairing link
scripts/score status                   # is it running, which URL
scripts/score service install          # run it as a systemd user service (boot, crash restart); the first terminal start offers this
curl -s http://127.0.0.1:8740/api/system   # "reachable": true means Score sees Hermes
```

Other launcher commands: `scripts/score pair` (a fresh pairing link), `password` (security password for managing
devices and the terminal), `logs -f`, `restart`, `stop`, `restore <backup>`. To start Score with the machine and restart it
after a crash, run `scripts/score service install` (a systemd user service; see [docs/SETUP.md](docs/SETUP.md) §9).

### 6. Use Score from your phone or another computer (HTTPS)

Score listens only on `127.0.0.1` by default. The quickest safe way in from another computer is an SSH tunnel:
`ssh -N -L 8740:127.0.0.1:8740 <user>@<host>`, then open `http://127.0.0.1:8740`.

For phones and day-to-day use, turn on **remote mode** (always HTTPS). With Score's own certificate (replace the
address with this machine's):

```bash
SCORE_HOST=192.168.1.20 SCORE_PUBLIC_ORIGINS=https://192.168.1.20:8741 scripts/score tls
SCORE_MODE=live SCORE_REMOTE=1 SCORE_HOST=192.168.1.20 scripts/score start   # https://192.168.1.20:8741
```

Install `~/.score/tls/ca.crt` on each device once (the page at `https://<host>:8741/setup/https` walks you through
it). With **Tailscale** you can skip that: `scripts/score tailscale` fetches a real certificate for the machine's
`ts.net` name. Details, including both at once: [docs/SETUP.md](docs/SETUP.md) §6b.

### Optional extras

- **Coding agents** (Team › Add agent › Coding agent): install and sign in to
  [Claude Code](https://docs.claude.com/claude-code), [Codex CLI](https://github.com/openai/codex) or
  [Antigravity `agy`](https://antigravity.google/docs/cli/install/) yourself; Score uses your own login and quota.
- **Web terminal**: start Score with `SCORE_TERMINAL=1` in remote mode and set a password with `scripts/score password`.
- **Library folder**: notes live in `~/score-vault` (a git repository Score creates); set `SCORE_VAULT` to move it.

### Upgrading

```bash
scripts/score stop
cp -a ~/.score ~/.score-backup-$(date +%F)        # database, media, keys
git -C ~/score pull && pnpm install && pnpm build
SCORE_MODE=live scripts/score start               # migrations run automatically at start
```

If you use the bridge plugin by copy instead of symlink, copy `hermes-plugin/score_bridge` again and restart the
gateway. All settings (`SCORE_PORT`, `SCORE_HOME`, …) are listed in [docs/SETUP.md](docs/SETUP.md).

## Pairing

Score has no user accounts. A browser proves it may control Score by opening a one-time pairing link, which only
someone with access to the server's terminal (or `$SCORE_HOME`) can get.

- The link is printed at startup, is valid for 15 minutes and works once. A newer link replaces an older one.
- From a browser that is already paired: Settings › Remote access › **Pair another device** (needs the security
  password). Or run `scripts/score pair`.
- A paired browser stays paired for up to 30 days (7 days without use). Clearing cookies unpairs it.

## Security model

- **Local by default.** Score listens on `127.0.0.1` only. Remote mode (phones, other computers) is always HTTPS, with
  Score's own certificate or a Tailscale one, and only for the origins you list.
- **Pairing.** There are no accounts. A browser must be paired with a one-time link before it can change anything
  (see [Pairing](#pairing)); managing devices and the terminal also need a security password set on the host.
- **Your credentials stay yours.** Score never reads Hermes credential files and never writes Hermes databases; it
  talks to Hermes through its CLI and gateway API, and redacts what comes from hooks before storing it.
- **Protected surfaces.** The cards that ask you to decide (approvals, questions, pauses, the privacy label) are
  marked so that no theme, custom CSS or imported look can hide, cover or relabel them.
- **Nothing runs without you.** Score controls the work it starts (turn and spend limits, deadline, stop) and says
  plainly what it cannot control; the Start a job dialog asks you to confirm that.

## Create and manage agents

Team, then Add agent, creates a Hermes profile (blank or copied from an existing agent), installs the bridge plugin
into it and gives it a color and shape. Before the first use, tell Score where to install the plugin from:

```bash
export SCORE_BRIDGE_INSTALL_URL='https://<your git host>/<you>/score.git#hermes-plugin/score_bridge'   # or 'file:///home/<you>/score#hermes-plugin/score_bridge'
export SCORE_BRIDGE_INSTALL_REF=<full 40-character commit hash>
```

Without these, Add agent stops with "Configure a pinned bridge installation URL first." The `#hermes-plugin/score_bridge` part selects the plugin inside the repository. (Only `https://` and
`file://` URLs are accepted, and the ref must be a full commit hash, not a tag or branch name.) Each step of a
create or delete is previewed before it runs. Deleting an agent asks you to type its name and keeps a private
export in `$SCORE_HOME/profile-backups/`. Details: [docs/SETUP.md](docs/SETUP.md) section 8.

## What is in the app

Score opens on the room at `/b`. The pictures below come from the built-in demo team (`lead`, `builder`, `reviewer`,
`designer`) running in demo mode, and `pnpm screenshots` regenerates them (see [Screenshots](#screenshots)).
[docs/USER-GUIDE.md](docs/USER-GUIDE.md) has longer notes on the individual pages; some of its sections still use the
older page names.

### The team room

![The team room: job tabs, a card that needs you, and the Results panel](docs/screenshots/team-room.png)

The room is where the team works. Each **job** is its own tab with its own conversation; you write to the team, and
agents hand work to each other with `@mentions`. Anything that needs your decision shows up pinned above the
conversation as a card (an approval, a question, an exchange that used up its turns). The side panel shows the **Results** (what changed, attached files, a live preview) and the
**Workbench**, and switches to Library or Runs from its **Work** menu.

![The team room on a phone: the needs-you card first, then the jobs, with the bottom navigation](docs/screenshots/team-room-phone.png)

On a phone the same room is one column with a bottom bar for Room, Team, Search and Settings; the side panel opens from
a button.

### A private conversation with one agent

![A one-to-one with lead: tool cards, the answer, and buttons to share it with the team room](docs/screenshots/one-to-one.png)

Click an agent's glyph at the top to talk to it privately. Only you and that agent see the conversation. When an answer
is worth keeping, **Share to the team room** posts it into a job, or **Bring into a new chat** continues it elsewhere.

![Try another reply: the designer's reply with a 2 / 2 pager and its action row](docs/screenshots/try-another.png)

**Try another** asks the agent again and keeps every version as one message with a pager (on a phone, swipe sideways).
Copy, Save to Library, Pin and Delete sit in the same row.

### Start a job

![The Start a job dialog: what to do, recipe, agents allowed, when, ask-me-before and limits, and the checks before it starts](docs/screenshots/start-job.png)

**Job** opens Start a job. Say what the team should do, choose who may take a step, when it runs (now, on a schedule,
or when another app calls), when it must ask you first, and its limits (turns per back-and-forth, a spend cap, an
optional deadline). Score lists the checks it ran before it starts, and you confirm that it controls the work it starts.
The recipe is either **lead decides** (the lead plans the steps) or one you saved.

### Runs

![A run in the Runs panel: spend and limits, an approval gate and the steps so far](docs/screenshots/run-steps.png)

A running job shows in the **Runs** panel: spend against its cap, the limits, the agents allowed, and every step with
its result. A gate that needs you (here "Approve s3?") shows what exactly will start and lets you approve or reject it,
with a note for the lead. Pause and Stop are always at the top.

![The same run as a graph: finished steps, the running step and the step that needs you](docs/screenshots/run-graph.png)

The **Graph** tab draws the same run: queued steps are dashed, running steps glow in the agent's colour, a step that
needs you is amber, and finished steps carry a tick.

### Recipes

![The Recipes editor: a saved recipe drawn as a graph of steps, with its toolbar and the list of steps to add](docs/screenshots/recipes.png)

A recipe is a saved set of steps: agent steps, a gate that waits for you, and a branch on a result. Draw it on the
graph or edit it **As text**, **Preview** it without running anything, and **Run** it from Start a job. Each save is a
new version.

### Team and agents

![An agent's page: personality, runs on, model and fallback models](docs/screenshots/agent.png)

**Team** lists the agents; each has a page with its personality (`SOUL.md`), its operating rules (`AGENTS.md`), the
model it runs on, and fallback models. Add agent creates a Hermes profile (see
[Create and manage agents](#create-and-manage-agents)). Agents are always shown by colour and shape together.

### An agent's screen

![The agent's screen: the steps builder took, the live view of its Bot Desktop, and the replay below](docs/screenshots/screen.png)

**Look at its screen** replays what an agent did: its steps, the browser, terminal and editor as they were at each
moment, and a replay bar you can scrub or set back to Live. It is a replay of recorded steps, not a remote desktop, and
it is read-only. The agent keeps working while you watch, and a pending approval is answered right there.

**Live screen**: when the agent has a Hermes Bot Desktop (computer use) running, its screen shows live above the replay,
about once a second. It is a picture only: Score never sends keys or clicks and never takes control. While someone has
taken over the screen in Hermes, Score hides it. A screen inside the agent's sandbox can't be shown.

### The Library

![The Library: a list of notes, an editor with a toolbar, backlinks and links in the note](docs/screenshots/library.png)

The Library is your notes: Markdown files in a folder Score keeps in a git repository, with a rich editor (or the plain
source), backlinks, upload and export. Agents can save their results there too.

### Search and commands

![Search and commands: results for "release" grouped into jobs, one-to-one chats, library notes and messages](docs/screenshots/search.png)

**Search** (Ctrl+K or Cmd+K) finds jobs, private chats, Library notes and messages, and runs commands. Type `@` to talk
to someone, `/` for a command.

### Needs you

![The needs-you cards: an exchange that used its turns and two approval requests](docs/screenshots/needs-you.png)

When an agent wants to install something or run a risky command, the card says what and gives you **Allow**,
**Don't allow** or **More**. These cards are built so no theme can hide, cover or relabel them.

![An agent's question: "Which branch should I use?" with two options](docs/screenshots/question.png)

An agent can also ask a question with options (or free text) and wait for your answer.

### Settings: Usage

![Settings, Usage: jobs done, first-time pass rate, wait time and spend, with a per-agent table](docs/screenshots/usage.png)

Settings holds Connections, Tools and triggers, Rules, Notifications, Look, Usage, Remote access and security, Advanced
and System. **Usage** shows what got done and what it cost: jobs per day, spend by agent, and a table per agent (jobs,
runs, median time, first-time pass, spend), with a CSV download.

### Look and the Customizer

![Settings, Look: dark, light or match the device, motion, text size and the themes](docs/screenshots/look.png)

The app is dark by default. **Look** switches between dark, light and the device setting, and sets motion and text size.
The built-in themes (Score, Paper, Night shift, Dense, Harbour, Ledger, Studio) change fonts, colours and shapes, never
the agent glyphs or the cards that need you.

![The Customizer: a live preview of the room next to colour, background, font, shape and spacing controls](docs/screenshots/customizer.png)

The **Customizer** edits a theme against a live preview (desktop, tablet or phone, light or dark) with undo, export and
import. A theme can be exported as a `.zip` and imported again. The guide for writing a theme is
[docs/THEMES.md](docs/THEMES.md).


### Terminal

Score can also open a terminal on the machine it runs on, in the browser. It is off by default (start Score with `SCORE_TERMINAL=1`) and works only over
HTTPS in remote mode, with a security password set on the host (`scripts/score password`); open terminals are listed
and can be closed under Settings. There is no screenshot because it needs a real shell, which the demo does not run.

## Troubleshooting

**The browser says "Pair this browser" or an action fails with "not paired".** This browser has not been paired,
or its pairing expired. Open the pairing link from the server terminal. If it is older than 15 minutes, was
already used, or has scrolled away: `scripts/score pair` (launcher), restart the server, or type `pair` in the
server terminal (any mode, when it runs in a terminal).

**"This pairing link is invalid or expired."** Same remedy: mint a new link. Only the newest link works.

**"Score is not built yet. Run `pnpm build` first."** `pnpm start`, `scripts/score start` and remote mode serve the
built web app, so `pnpm build` has to run first (and again after every `git pull`).

**"listen EADDRINUSE: address already in use 127.0.0.1:8740".** Another program (maybe another Score) holds the
port. Pick another with `SCORE_PORT=8750`, or stop the other one: `scripts/score stop`, or find it with
`ss -ltnp | grep 8740`.

**"Another Score server (pid N) is using <path>".** Two Score servers must not share one `SCORE_HOME`. Stop the other
one, or give this one its own `SCORE_HOME`. Do not mix the launcher and systemd for the same home.

**Hermes is unreachable (live mode).** Run `curl -s http://127.0.0.1:8740/api/system` and read `degraded`.
"Gateway unreachable": the Hermes gateway is not running or has no API server key (SETUP section 7; check
`curl -s http://127.0.0.1:8642/v1/health`). "<profile>: credentials unavailable": that profile has no key in
`~/.score/hermes-keys/`. `SCORE_HERMES_URL` and `SCORE_HERMES_HOME` point Score at a gateway or Hermes home in a
non-default place. If nothing shows up in the timeline although Hermes runs, check the bridge plugin: it must be
enabled in each profile, and the `bridge.producers` count in the same endpoint shows how many are connected.

**A browser on another machine gets "Request host is not allowed" or a 403.** In remote mode the address in the
browser must match one of the `SCORE_PUBLIC_ORIGINS` exactly (scheme, host and port). `localhost` and `127.0.0.1`
are different hosts.

**The server will not start in remote mode.** The message names the problem. Typical ones: a non-loopback
`SCORE_HOST` without `SCORE_REMOTE=1`; `SCORE_PUBLIC_ORIGINS` missing; plain HTTP
without `SCORE_REMOTE_INSECURE_HTTP=accept`; `SCORE_TLS_CERT` without `SCORE_TLS_KEY`; or the browser port equal to
`SCORE_BRIDGE_PORT`.

**Add agent says "Configure a pinned bridge installation URL first."** Set `SCORE_BRIDGE_INSTALL_URL` and
`SCORE_BRIDGE_INSTALL_REF` (see above) and restart Score.

**I need more detail in the log.** `scripts/score logs -f`, or the terminal where `pnpm start` runs. Request logs
redact cookies and authorization headers.

**Codex-free.** Score needs no Codex, OpenAI or other cloud account to run. Codex CLI is only a tool the maintainers
use to write code (see [CLAUDE.md](CLAUDE.md)); nothing in the app calls it. In demo mode no model is called at
all; in live mode your own Hermes calls the providers you configured.

## For contributors

- Screenshots: `pnpm screenshots` (set `SCORE_WEB_PORT` to a free port) builds the app, starts a fake-mode Score in a
  throwaway folder under `/tmp`, pairs a browser with it and rewrites `docs/screenshots/*.png`
  (`e2e/readme/readme-screenshots.spec.ts`). It never touches `~/.score` or a live server and calls no model; look at
  the pictures before committing them.
- Checks: `pnpm check` (lint, format, typecheck, tests, license check). End-to-end: `pnpm e2e` (see SETUP section 5).
- Rules for coding agents and humans: [AGENTS.md](AGENTS.md). Plan: [docs/PLAN.md](docs/PLAN.md). Architecture:
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). API contract: [docs/API-CONTRACT.md](docs/API-CONTRACT.md).

## License

Score is free for personal use, research and noncommercial organisations under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md) (see also [NOTICE](NOTICE)). Commercial use needs a separate
license: see [COMMERCIAL.md](COMMERCIAL.md). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
