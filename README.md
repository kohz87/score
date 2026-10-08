# Score

Score is a local-first web app for running a team of [Hermes Agent](https://github.com/NousResearch/hermes-agent)
profiles. One screen shows what every agent is doing right now, agents hand work to each other with `@mentions`
in Chat rooms, and anything that needs your decision (an approval, a review) waits for you in one place.
It runs on your machine, keeps its own data in `~/.score`, and talks to Hermes through the `hermes` CLI and the
gateway API. It never reads your Hermes credential files and never writes Hermes databases.

![Score's Now page: a timeline of four agents, a thread, an approval card and a message box](docs/screenshots/now.png)

(The screenshot shows the built-in demo team: `lead`, `builder`, `reviewer`, `designer`.)

## Requirements

- Linux (tested on Ubuntu 26.04, x86_64). Other systems are untested.
- Node.js 24 (22.22.2 or newer also works), git, and pnpm 12 through corepack. The exact setup, including a
  Node install that needs no sudo, is in [docs/SETUP.md](docs/SETUP.md) section 1.
- A running Hermes Agent (v0.21.x) only for live mode. The demo needs no Hermes at all.

## Install and try the demo

```bash
git clone <repo-url> score && cd score
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0   # skips corepack's one-time download question
pnpm install
pnpm dev
```

`pnpm dev` starts the server with a built-in fake team (`SCORE_MODE=fake` is the default, so no Hermes is needed
and no model is called) and the web app:

- Web app: <http://127.0.0.1:5173>
- Server: <http://127.0.0.1:8740> (`curl http://127.0.0.1:8740/api/health` answers `{"ok":true,"contract":1}`)

The server prints a pairing link in its terminal:

```
Pair this browser: http://127.0.0.1:5173/pair#<one-time token>
```

Open that link once. Until a browser is paired you can look around, but anything that changes something (approve,
pause, edit, send) is refused with a "pair this browser" message. See [Pairing](#pairing) below.

The demo plays a short scripted run (a plan, a hand-off, a review that sends work back, an approval waiting for
you) and then repeats it. Two switches change the pace: `SCORE_FAKE_SPEED=2` runs it twice as fast, and
`SCORE_FAKE_LOOP=false` plays it once.

`pnpm dev` is for development. For everyday use run the built app (next section).

## Everyday use

Build once, then serve the web app and the API from a single port:

```bash
pnpm build
pnpm start          # http://127.0.0.1:8740, runs in this terminal, Ctrl+C stops it
```

The default mode is still the demo. Add `SCORE_MODE=live` to use your real Hermes (see
[Connect your Hermes](#connect-your-hermes)):

```bash
SCORE_MODE=live pnpm start
```

To keep Score running in the background, use the launcher. It writes `score.pid` and `score.log` in `$SCORE_HOME`
(default `~/.score`):

```bash
scripts/score start     # start in the background and print the first pairing link
scripts/score status    # running? which pid and URL
scripts/score pair      # print a fresh pairing link for another browser
scripts/score logs -f   # follow the log (without -f: the last 100 lines)
scripts/score stop
```

Environment variables you give `scripts/score start` (such as `SCORE_MODE=live`) are passed to the server. To run
`score` from anywhere: `ln -s "$PWD/scripts/score" ~/.local/bin/score`. A systemd user service example and the
upgrade steps are in [docs/SETUP.md](docs/SETUP.md) section 9.

Settings you may want to change (all optional):

| Variable           | Default                 | What it does                                                                |
| ------------------ | ----------------------- | --------------------------------------------------------------------------- |
| `SCORE_MODE`       | `fake`                  | `fake` is the demo team, `live` talks to Hermes                             |
| `SCORE_PORT`       | `8740`                  | server port (the built app and the API share it)                            |
| `SCORE_HOME`       | `~/.score`              | where Score keeps its database, media and launcher files                    |
| `SCORE_HOST`       | `127.0.0.1`             | bind address; anything but loopback needs remote mode                       |
| `SCORE_WEB_PORT`   | `5173`                  | Vite's port in `pnpm dev` only                                              |
| `SCORE_WEB_ORIGIN` | follows `SCORE_WEB_PORT` | web origin in `pnpm dev`; only needed for a non-default host              |

## Pairing

Score has no user accounts. A browser proves it may control Score by opening a one-time pairing link, which only
someone with access to the server's terminal (or `$SCORE_HOME`) can get.

- The link is printed at startup, is valid for 15 minutes and works once. A newer link replaces an older one.
- To get another one: run `scripts/score pair` (if you started Score with the launcher), restart the server, or, in
  remote mode, type `pair` in the server terminal.
- A paired browser stays paired for up to 30 days (7 days without use). Clearing cookies unpairs it.

## Connect your Hermes

Live mode needs three things: an API key per Hermes profile so Score can drive it, the Score bridge plugin in
each profile you want Score to watch, and `SCORE_MODE=live`.

1. Follow [docs/SETUP.md](docs/SETUP.md) section 7. It writes Hermes config (`API_SERVER_KEY`) and restarts the
   gateway, so read the commands before you run them.
2. Install the bridge plugin into every profile: [hermes-plugin/README.md](hermes-plugin/README.md).
3. Start Score with `SCORE_MODE=live` (`SCORE_MODE=live pnpm start`, or `SCORE_MODE=live scripts/score start`).

To check the connection, ask the server how it sees Hermes (this endpoint needs no pairing):

```bash
curl -s http://127.0.0.1:8740/api/system
```

`"reachable": true` means Score reaches the Hermes gateway; `"degraded"` lists in plain words what is not
working, such as "Gateway unreachable" or a profile whose key is missing.

## Use Score from another machine

Score listens on `127.0.0.1` only, which is the safest choice. Two ways to reach it from elsewhere:

**SSH tunnel (simplest, nothing to configure).** On the machine you are sitting at:

```bash
ssh -N -L 8740:127.0.0.1:8740 <user>@<host>     # built app (pnpm start)
# or, for pnpm dev:  ssh -N -L 5173:127.0.0.1:5173 <user>@<host>
```

Then open `http://127.0.0.1:8740` locally. Use the pairing link the same way, with the local port.

**Remote mode.** Score itself listens on a network address, with pairing required for every request. Run
`pnpm build` first (remote mode serves the built app). Remote mode needs `SCORE_REMOTE=1`, a numeric
`SCORE_HOST`, and `SCORE_PUBLIC_ORIGINS` (the exact addresses your browsers will use). It uses `SCORE_PORT` 8741 by
default and a second, loopback-only port (`SCORE_BRIDGE_PORT`, default 8740) for the Hermes bridge plugin.

- With TLS (recommended), using your own certificate (for example one made by `tailscale cert`):

  ```bash
  SCORE_REMOTE=1 SCORE_HOST=100.x.y.z SCORE_PORT=8741 \
  SCORE_TLS_CERT=$PWD/myhost.tailnet.ts.net.crt SCORE_TLS_KEY=$PWD/myhost.tailnet.ts.net.key \
  SCORE_PUBLIC_ORIGINS=https://myhost.tailnet.ts.net:8741 pnpm start
  ```

- Plain HTTP on a network you trust. Anyone on that network can read and control Score, and the app shows a
  permanent warning banner. You must acknowledge this explicitly:

  ```bash
  SCORE_REMOTE=1 SCORE_REMOTE_INSECURE_HTTP=accept SCORE_HOST=192.168.1.20 \
  SCORE_PUBLIC_ORIGINS=http://192.168.1.20:8741 pnpm start
  ```

Wildcard addresses (`0.0.0.0`, `::`) also need `SCORE_REMOTE_ANY=1`. In remote mode type `pair` in the server
terminal for another pairing link, and revoke browsers under Settings, Remote access. Full details:
[docs/SETUP.md](docs/SETUP.md) section 6b.

## Create and manage agents

Team, then Add agent, creates a Hermes profile (blank or copied from an existing agent), installs the bridge plugin
into it and gives it a color and shape. Before the first use, tell Score where to install the plugin from:

```bash
export SCORE_BRIDGE_INSTALL_URL=https://<your git host>/<you>/score.git   # or file:///home/<you>/score
export SCORE_BRIDGE_INSTALL_REF=<full 40-character commit hash>
```

Without these, Add agent stops with "Configure a pinned bridge installation URL first." (Only `https://` and
`file://` URLs are accepted, and the ref must be a full commit hash, not a tag or branch name.) Each step of a
create or delete is previewed before it runs. Deleting an agent asks you to type its name and keeps a private
export in `$SCORE_HOME/profile-backups/`. Details: [docs/SETUP.md](docs/SETUP.md) section 8.

## What is in the app

Score has six destinations along the top. [docs/USER-GUIDE.md](docs/USER-GUIDE.md) describes each in detail.

- **Now** shows the team's work as a timeline (Score), a flow graph of one run (Flow) and every routine
  (Routines). It also holds the latest thread, whatever needs your approval, and a message box. Pause everyone
  stops all agents at once.
- **Chat** has rooms and direct conversations with agents. Mention `@agent` to hand work over; slash commands such
  as `/assign` and `/routine` create tasks and schedules.
- **Tasks** is a board with five columns (Planned, Working, In review, Needs you, Done), filters, and a drawer with
  steps, activity and an approval or comment box.
- **Team** lists your agents; each has a page for personality, model, skills, memory, tools, routines and
  permissions, and Add agent lives here.
- **Reports** shows tasks finished per day, where each agent's time goes, approvals, and a CSV export.
- **Settings** holds models and keys, connections (tool servers, messaging), team-wide rules and approvals,
  every Hermes setting (Advanced), and remote access.

- **Watch** (Now › an agent, or "Watch" on its Team page) replays what an agent did: its terminal, the files it changed
  and the pages it looked at, with a timeline you can drag back. It is a replay of recorded events, not a remote view of
  a screen; "Pause <agent>" stops new work and "Open in terminal" copies the command to continue its session yourself.

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

- Checks: `pnpm check` (lint, format, typecheck, tests, license check). End-to-end: `pnpm e2e` (see SETUP section 5).
- Rules for coding agents and humans: [AGENTS.md](AGENTS.md). Plan: [docs/PLAN.md](docs/PLAN.md). Architecture:
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). API contract: [docs/API-CONTRACT.md](docs/API-CONTRACT.md).

## License

Score is free for personal use, research and noncommercial organisations under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md) (see also [NOTICE](NOTICE)). Commercial use needs a separate
license: see [COMMERCIAL.md](COMMERCIAL.md). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
