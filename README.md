# Score

Score is a local-first web app for running a team of [Hermes Agent](https://github.com/NousResearch/hermes-agent)
profiles. Work happens in a **team room**: you start jobs, agents hand work to each other with `@mentions`, and anything
that needs your decision (an approval, a question, a review) waits for you in one place. You can run several teams, talk
to any agent privately, and watch what an agent is doing on its screen.

It runs on your machine, keeps its own data in `~/.score`, and talks to Hermes through the `hermes` CLI and the gateway
API. It never reads your Hermes credential files and never writes Hermes databases. Claude Code, Codex and Antigravity
can join the team as coding agents.

![Score's team room: job tabs, a card that needs you, the conversation and the Results panel](docs/screenshots/team-room.png)

(The screenshots show the built-in demo team: `lead`, `builder`, `reviewer`, `designer`. `pnpm screenshots` regenerates
them.) The full walk-through is the [user guide](docs/USER-GUIDE.md).

## A tour

### The team room and more teams

Each **job** is a tab with its own conversation. Cards pinned above it ask for your decision, and the side panel shows
the **Results** (what changed, drafts, a live preview), the **Workbench**, the **Library** and **Runs**. **Team room ▾**
switches between teams: make another with **New team…**, choose its agents and a lead, and jobs, hand-offs and runs work
there the same way.

![The Team room menu with a second team, an older room and the agents' own chats outside Score](docs/screenshots/team-switcher.png)

![The New team dialog: a name, members and a lead](docs/screenshots/new-team.png)

### Start a job

**Job** opens Start a job: what to do, a recipe (**lead decides** or one you saved), who may take a step, when it runs
(now, on a schedule, or when another app calls), when it must ask you first, and its limits. Score lists the checks it ran
before it starts, and you confirm that it controls the work it starts.

![The Start a job dialog](docs/screenshots/start-job.png)

### Runs and recipes

A running job shows under **Runs**: spend against its cap, every step with its result, and gates that wait for you. The
**Graph** tab draws the same run. A **recipe** is a saved set of steps, with gates and branches, drawn as a graph or
edited as text, previewed without running anything and saved in versions.

![A run in the Runs panel: spend and limits, an approval gate and the steps so far](docs/screenshots/run-steps.png)

![The same run as a graph](docs/screenshots/run-graph.png)

![The Recipes editor](docs/screenshots/recipes.png)

### Needs you and questions

When an agent wants to run a risky command, an exchange between agents uses up its turns, or an agent asks you something,
a card says what and lets you decide. No theme can hide, cover or relabel these cards.

![The needs-you cards: an exchange that used its turns and two approval requests](docs/screenshots/needs-you.png)

![An agent's question: "Which branch should I use?" with two options](docs/screenshots/question.png)

### One-to-ones

Click an agent at the top to talk to it privately. **Share to the team room** (or **Share to a team**) posts an answer
into a job, **Bring into a new chat** continues it elsewhere, and **Try another** asks again and keeps every version.

![A one-to-one with lead](docs/screenshots/one-to-one.png)

![Try another reply: a 2 / 2 pager and the action row](docs/screenshots/try-another.png)

### An agent's page and screen

An agent's page holds its personality (`SOUL.md`), rules (`AGENTS.md`), model and fallbacks, memory, skills and tools.
**Look at its screen** replays what it did, read-only. When the agent has a Hermes Bot Desktop running, a **Live screen**
shows it about once a second: a picture only, Score never sends keys or clicks.

![An agent's page](docs/screenshots/agent.png)

![The agent's screen with its live view](docs/screenshots/screen.png)

![The Live screen card](docs/screenshots/live-screen.png)

### Library, Search and Usage

The **Library** is your notes as Markdown in a git folder, with backlinks and history; agents can save results there.
**Search** (`⌘K` or `Ctrl+K`) finds jobs, chats, notes and messages and runs commands (`@` to talk to someone, `/` for a
command). **Usage** shows what got done and what it cost.

![The Library](docs/screenshots/library.png)

![Search and commands](docs/screenshots/search.png)

![Settings, Usage](docs/screenshots/usage.png)

### Triggers, Look and the Customizer

**Settings › Tools and triggers** lets another app start a job by calling an address; with several teams a trigger picks
the team it **starts jobs in**. **Settings › Look** is dark by default, with light, motion, text size and seven themes,
and the **Customizer** edits a theme against a live preview.

![A trigger that starts jobs in a team](docs/screenshots/trigger.png)

![Settings, Look](docs/screenshots/look.png)

![The Customizer](docs/screenshots/customizer.png)

### On a phone

![The team room on a phone: the needs-you card first, then the jobs, with the bottom navigation](docs/screenshots/team-room-phone.png)

The same room is one column with a bottom bar for Room, Team, Search and Settings; the side panel opens as a sheet.

## Requirements

- Linux (tested on Ubuntu 26.04, x86_64), `git`, `curl`, `tar`, `xz`.
- **Node.js 24** and **pnpm 12**. Coding agents and Library moves also use `python3` (3.9 or newer).
- For real agents: [Hermes Agent](https://github.com/NousResearch/hermes-agent), tested with **v0.22.5**. Without
  Hermes, Score runs a demo team (`SCORE_MODE=fake`) that calls no model.
- A browser. Score serves its own web app; nothing is loaded from a CDN at runtime.

## Quick start

### 1. Try the demo

Node 24 and pnpm 12 without sudo are in [docs/SETUP.md](docs/SETUP.md) §1. Then:

```bash
git clone <repo-url> ~/score && cd ~/score
pnpm install
pnpm build
pnpm start                  # http://127.0.0.1:8740 with a built-in demo team; Ctrl+C stops it
```

The terminal prints a one-time **pairing link** (`Pair this browser: …/pair#…`). Open it once in your browser; until a
browser is paired you can look around but not change anything (see [Pairing](#pairing)). `pnpm dev` runs the same demo
with live reload for development (web on port 5173).

### 2. Use your real Hermes agents

Install Hermes with its own installer, run `hermes setup` and `hermes gateway start` (see the
[Hermes Agent README](https://github.com/NousResearch/hermes-agent)), then:

1. **Give Score an API key for each Hermes profile** (Score keeps its copies in `~/.score/hermes-keys/`, mode 0600). These
   commands change Hermes's config and restart its gateway, so read them first:

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

3. **Run Score against Hermes:**

   ```bash
   SCORE_MODE=live scripts/score start    # runs in the background and prints a pairing link
   scripts/score status                   # is it running, which URL
   scripts/score service install          # run it as a systemd user service (boot, crash restart)
   curl -s http://127.0.0.1:8740/api/system   # "reachable": true means Score sees Hermes
   ```

   Other launcher commands: `scripts/score pair` (a fresh pairing link), `password` (security password for managing
   devices and the terminal), `logs -f`, `restart`, `stop`, `restore <backup>`.

4. **To create agents from Score** (Team › Add an agent), tell Score where to install the plugin from, pinned to a commit
   (details in [docs/SETUP.md](docs/SETUP.md) §8). Deleting an agent asks you to type its name and keeps a private export
   in `$SCORE_HOME/profile-backups/`.

   ```bash
   export SCORE_BRIDGE_INSTALL_URL="file://$HOME/score#hermes-plugin/score_bridge"
   export SCORE_BRIDGE_INSTALL_REF="$(git -C ~/score rev-parse HEAD)"
   ```

### 3. From a phone or another computer

Score listens only on `127.0.0.1` by default. The quickest safe way in is an SSH tunnel:
`ssh -N -L 8740:127.0.0.1:8740 <user>@<host>`, then open `http://127.0.0.1:8740`. For phones and day-to-day use, turn on
**remote mode** (always HTTPS, with Score's own certificate or a Tailscale one): `scripts/score tls`, then
`SCORE_MODE=live SCORE_REMOTE=1 SCORE_HOST=<address> scripts/score start`. The steps, including installing the
certificate on each device, are in [docs/SETUP.md](docs/SETUP.md) §6b.

### Optional extras

- **Coding agents** (Team › Add an agent › A coding tool): install and sign in to
  [Claude Code](https://docs.claude.com/claude-code), [Codex CLI](https://github.com/openai/codex) or
  [Antigravity `agy`](https://antigravity.google/docs/cli/install/) yourself; Score uses your own login and quota.
- **Web terminal**: start Score with `SCORE_TERMINAL=1` in remote mode and set a password with `scripts/score password`. It
  needs a C++ toolchain once (**sudo** `apt install build-essential python3`, then `pnpm rebuild node-pty`). There is no
  screenshot because it needs a real shell, which the demo does not run.
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

Score has no user accounts. A browser proves it may control Score by opening a one-time pairing link, which only someone
with access to the server's terminal (or `$SCORE_HOME`) can get.

- The link is printed at startup, is valid for 15 minutes and works once. A newer link replaces an older one.
- From a browser that is already paired: Settings › Remote access and security › **Pair another device** (needs the
  security password). Or run `scripts/score pair`.
- A paired browser stays paired for up to 30 days (7 days without use). Clearing cookies unpairs it.

## Security model

- **Local by default.** Score listens on `127.0.0.1` only. Remote mode is always HTTPS, and only for the origins you list.
- **Pairing.** A browser must be paired with a one-time link before it can change anything; managing devices and the
  terminal also need a security password set on the host.
- **Your credentials stay yours.** Score never reads Hermes credential files and never writes Hermes databases; it talks
  to Hermes through its CLI and gateway API, and redacts what comes from hooks before storing it.
- **Protected surfaces.** The cards that ask you to decide (approvals, questions, pauses, the privacy label) are marked so
  that no theme, custom CSS or imported look can hide, cover or relabel them.
- **Nothing runs without you.** Score controls the work it starts (turn and spend limits, deadline, stop) and says plainly
  what it cannot control; Start a job asks you to confirm that. Coding agents can read what your user can read (Claude
  Code blocks your Hermes, Score and SSH folders); Start a job asks you to accept that too.

## Troubleshooting

**"Pair this browser" or an action fails with "not paired".** This browser has not been paired, or its pairing expired.
Open the pairing link from the server terminal, or run `scripts/score pair` for a new one (only the newest link works).

**"Score is not built yet. Run `pnpm build` first."** `pnpm start`, `scripts/score start` and remote mode serve the built
web app, so run `pnpm build` first (and again after every `git pull`).

**"listen EADDRINUSE: address already in use 127.0.0.1:8740".** Another program (maybe another Score) holds the port.
Pick another with `SCORE_PORT=8750`, or find it with `ss -ltnp | grep 8740`.

**"Another Score server (pid N) is using <path>".** Two Score servers must not share one `SCORE_HOME`. Stop the other one,
or give this one its own `SCORE_HOME`. Don't mix the launcher and systemd for the same home.

**Hermes is unreachable (live mode).** Run `curl -s http://127.0.0.1:8740/api/system` and read `degraded`. "Gateway
unreachable": the Hermes gateway is not running or has no API server key (check `curl -s http://127.0.0.1:8642/v1/health`).
"<profile>: credentials unavailable": that profile has no key in `~/.score/hermes-keys/`. If nothing shows up although
Hermes runs, check that the bridge plugin is enabled in each profile; `bridge.producers` in the same endpoint counts the
connected ones. `SCORE_HERMES_URL` and `SCORE_HERMES_HOME` point Score at a gateway or Hermes home in a non-default place.

**A browser on another machine gets "Request host is not allowed" or a 403.** In remote mode the address in the browser
must match one of the `SCORE_PUBLIC_ORIGINS` exactly (scheme, host and port). `localhost` and `127.0.0.1` are different
hosts.

**The server will not start in remote mode.** The message names the problem: a non-loopback `SCORE_HOST` without
`SCORE_REMOTE=1`, `SCORE_PUBLIC_ORIGINS` missing, plain HTTP without `SCORE_REMOTE_INSECURE_HTTP=accept`, or
`SCORE_TLS_CERT` without `SCORE_TLS_KEY`.

**Add an agent says "Configure a pinned bridge installation URL first."** Set `SCORE_BRIDGE_INSTALL_URL` and
`SCORE_BRIDGE_INSTALL_REF` (Quick start, step 2) and restart Score.

**I need more detail in the log.** `scripts/score logs -f`, or the terminal where `pnpm start` runs. Request logs redact
cookies and authorization headers.

**Codex-free.** Score needs no Codex, OpenAI or other cloud account to run. Codex CLI is only a tool the maintainers use to
write code (see [CLAUDE.md](CLAUDE.md)); nothing in the app calls it. In demo mode no model is called at all; in live mode
your own Hermes calls the providers you configured.

## For contributors

- Screenshots: `pnpm screenshots` (set `SCORE_WEB_PORT` to a free port) builds the app, starts a fake-mode Score in a
  throwaway folder under `/tmp`, pairs a browser with it and rewrites `docs/screenshots/*.png`
  (`e2e/readme/readme-screenshots.spec.ts`). It never touches `~/.score` or a live server and calls no model; look at the
  pictures before committing them.
- Checks: `pnpm check` (lint, format, typecheck, tests, license check). End-to-end: `pnpm e2e` (see SETUP §5).
- Rules for coding agents and humans: [AGENTS.md](AGENTS.md). Plan: [docs/PLAN.md](docs/PLAN.md). Architecture:
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). API contract: [docs/API-CONTRACT.md](docs/API-CONTRACT.md). Themes:
  [docs/THEMES.md](docs/THEMES.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## License

Score is free for personal use, research and noncommercial organisations under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md) (see also [NOTICE](NOTICE)). Commercial use needs a separate
license: see [COMMERCIAL.md](COMMERCIAL.md). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
