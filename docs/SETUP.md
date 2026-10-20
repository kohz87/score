# Setup

Follow top to bottom on a fresh Linux machine (tested: Ubuntu 26.04.1 LTS, x86_64) to reach a running dev
server. Steps marked **(system)** need sudo or change things outside this repo. Everything else is
project-local.

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| git | any recent | source control |
| curl, tar, xz | any | Node download |
| Node.js | **24.21.0** (LTS "Krypton"; ≥ 22.22.2 works) | server, build, tests |
| pnpm | **12.9.1**, via corepack (pinned in `package.json → packageManager`) | package manager |
| Hermes Agent | v0.21.x | only for live mode; the fake mode needs none |

### 1a. Node 24 without sudo (user-local)

Installs into `~/.local/opt` and symlinks into `~/.local/bin`, which must be on your `PATH` (it is on
Ubuntu by default once the directory exists; log out and in if `node -v` is not found).

```bash
V=v24.21.0; D=node-$V-linux-x64
cd ~/.cache && curl -fsSLO https://nodejs.org/dist/$V/$D.tar.xz
curl -fsSL https://nodejs.org/dist/$V/SHASUMS256.txt | grep " $D.tar.xz\$" | sha256sum -c -
mkdir -p ~/.local/opt ~/.local/bin && tar -xJf $D.tar.xz -C ~/.local/opt && rm $D.tar.xz
for b in node npm npx corepack; do ln -sf ~/.local/opt/$D/bin/$b ~/.local/bin/$b; done
corepack enable --install-directory ~/.local/bin
node -v    # v24.21.0
```

(Any other Node manager works too: nvm, fnm, mise. The repo has a `.node-version` file.)

### 1b. pnpm

Corepack downloads the pinned pnpm on first use. To skip the interactive prompt:

```bash
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
pnpm -v    # 12.9.1
```

### 1b2. python3

Score calls `python3` (3.9+, standard library only) for kernel calls Node doesn't offer: atomic no-replace renames
(Knowledge moves, `renameat2`) and identity-safe signals and parent-death handling for coding agents (pidfds,
`PR_SET_PDEATHSIG`). Ubuntu ships it; set `SCORE_PYTHON` to use another interpreter. Without it, Knowledge moves and
coding-agent turns are refused with a clear message (everything else works).

### 1c. uv (Python tooling for the Hermes bridge plugin, user-local)

```bash
V=0.12.23; T=uv-x86_64-unknown-linux-gnu.tar.gz
cd ~/.cache && curl -fsSLO https://github.com/astral-sh/uv/releases/download/$V/$T
curl -fsSL https://github.com/astral-sh/uv/releases/download/$V/$T.sha256 | sha256sum -c -
tar -xzf $T && install -m 755 uv-x86_64-unknown-linux-gnu/{uv,uvx} ~/.local/bin/
rm -rf $T uv-x86_64-unknown-linux-gnu
uv --version    # uv 0.12.23
```

## 2. Install

```bash
git clone <repo-url> score && cd score
pnpm install            # uses the committed pnpm-lock.yaml; install scripts are off (see pnpm-workspace.yaml)
```

## 3. Run

```bash
pnpm dev
```

- Web: http://127.0.0.1:5173 (Vite; proxies `/api` to the server)
- Server: http://127.0.0.1:8740 (`GET /api/health` → `{"ok":true,...}`)
- Ports: `SCORE_WEB_PORT`, `SCORE_PORT`; bind host `SCORE_HOST` (default `127.0.0.1`).

## 4. Checks

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm license:check      # dependency license policy (see AGENTS.md)
pnpm check              # all of the above
```

## 5. End-to-end tests (Playwright)

```bash
pnpm e2e:install        # downloads Chromium to ~/.cache/ms-playwright (per-user cache, no sudo)
```

**(system)** Chromium needs OS libraries (73 packages on a minimal Ubuntu 26.04: atk, fonts, xvfb, …):

```bash
sudo env "PATH=$PATH" pnpm exec playwright install-deps chromium
```

Then:

```bash
pnpm e2e                # starts `pnpm dev` automatically if it is not already running
```

## 6. Codex CLI (the implementer; see CLAUDE.md)

Codex CLI (signed in with ChatGPT) runs implementation tasks in a sandbox. On Ubuntu 24.04+ the sandbox needs the
**system** bubblewrap, because AppArmor only lets `/usr/bin/bwrap` create user namespaces **(system)**:

```bash
sudo apt install -y bubblewrap
codex exec --disable apps -m gpt-6.1-sol -s read-only "run: ls" # should list files, not fail with RTM_NEWADDR
```

## 6b. Remote access (optional)
Default is local only (`127.0.0.1`); a non-loopback `SCORE_HOST` without `SCORE_REMOTE=1` is refused. Build the web app first
(`pnpm build`); remote mode serves `apps/web/dist` itself.

Remote access is **HTTPS only**. Plain HTTP is not a secure context (the browser disables features Score needs, and the
pairing cookie and API keys would cross the network in clear), so over plain HTTP Score shows only an HTTPS setup guide
(`/setup/https`) and answers `/api` with `426 https_required`. Without a certificate it starts in guide-only mode and
serves nothing else. `SCORE_REMOTE_INSECURE_HTTP` was removed and is ignored.

Option A (recommended): Score's own certificate authority. Needs `openssl` on the Score machine.
```bash
SCORE_HOST=192.168.1.20 SCORE_PUBLIC_ORIGINS=https://192.168.1.20:8741 scripts/score tls
SCORE_REMOTE=1 SCORE_HOST=192.168.1.20 scripts/score start     # uses $SCORE_HOME/tls/server.{crt,key} automatically
```
`scripts/score tls` writes a local CA (`ca.crt`, `ca.key`; 10 years) and a server certificate (825 days, valid for
`SCORE_HOST`, the hosts in `SCORE_PUBLIC_ORIGINS`, `localhost` and `127.0.0.1`) into `$SCORE_HOME/tls/` (0700, keys 0600).
Running it again keeps the CA and only re-issues the server certificate, so devices stay trusted; `--new-ca` replaces both.
Then install **`ca.crt`** (public; download it from `https://<host>:8741/setup/https/score-ca.crt` or copy the file) on every
device: Windows (Install Certificate, Trusted Root Certification Authorities), macOS (Keychain, System, Always Trust), iOS
(install the profile, then Settings, General, About, Certificate Trust Settings), Android (Settings, Security, Install a
certificate, CA certificate), Linux/Chrome (Settings, Manage certificates, Authorities, Import). The setup guide page in
Score lists the same steps. When `SCORE_PUBLIC_ORIGINS` is unset, `scripts/score start` derives
`https://$SCORE_HOST:${SCORE_PORT:-8741}`; a `http://` value there is rewritten to `https://` when it uses these files.

Option T (recommended for phones and use away from home): **Tailscale, together with option A.** Devices on your tailnet
get a real Let's Encrypt certificate for the machine's `ts.net` name, so nothing has to be installed on them; the LAN
address keeps working with Score's own certificate. Score picks the certificate by the name the browser asks for (SNI).
Needs Tailscale on the Score machine with MagicDNS and HTTPS certificates on (admin console › DNS) and, once,
`sudo tailscale set --operator=$USER`.
```bash
scripts/score tailscale     # fetches the ts.net certificate into $SCORE_HOME/tls/tailscale/
SCORE_REMOTE=1 SCORE_REMOTE_ANY=1 SCORE_HOST=0.0.0.0 \
SCORE_PUBLIC_ORIGINS=https://192.168.1.20:8741 scripts/score start
```
`start` adds `https://<name>.ts.net:8741` to the public origins and sets `SCORE_TLS_NAMES_DIR` (a folder of
`<name>.crt`/`<name>.key` pairs) when that folder has a certificate. The server renews Tailscale certificates daily
(`tailscale cert` replaces them only when due) and picks up renewed files without a restart. `SCORE_HOST=0.0.0.0` (with
`SCORE_REMOTE_ANY=1`) is needed so Score answers on both the LAN and the Tailscale address; Host/Origin checks and pairing
still apply to every request.

Option B: your own certificate (reverse proxy, Tailscale, a CA you run), e.g. with Tailscale:
```bash
tailscale cert myhost.tailnet.ts.net        # writes myhost.tailnet.ts.net.crt / .key (run by you, not by Score)
SCORE_REMOTE=1 SCORE_HOST=100.x.y.z SCORE_PORT=8741 \
SCORE_TLS_CERT=$PWD/myhost.tailnet.ts.net.crt SCORE_TLS_KEY=$PWD/myhost.tailnet.ts.net.key \
SCORE_PUBLIC_ORIGINS=https://myhost.tailnet.ts.net:8741 pnpm --filter @score/server start
```
Browsers then use the `https://` address; the same port answers plain HTTP with the guide.
Wildcard binds (`0.0.0.0`, `::`) additionally need `SCORE_REMOTE_ANY=1`. `SCORE_PUBLIC_ORIGINS` is a comma-separated list
of exact origins (scheme, host, port) browsers use. The bridge plugin keeps using loopback (`SCORE_BRIDGE_PORT`, default
8740). Type `pair` in the server terminal to mint another pairing link; manage and revoke browsers in Settings.

## 6c. Web terminal (optional, PLAN 7.3)

Off by default; start Score with `SCORE_TERMINAL=1` to enable it (Settings › Remote access shows the state). It uses
`node-pty`, a native module with no Linux prebuilt binary, so it is an optional dependency that `pnpm install` compiles
(`allowBuilds` in `pnpm-workspace.yaml`). That needs a C++ toolchain: on Ubuntu `sudo apt install build-essential python3`
(system-level: ask the owner first). Without one, `pnpm install` still succeeds; Score then reports the terminal as
unavailable ("node-pty not built"). After installing a toolchain run `pnpm rebuild node-pty`. The terminal also needs HTTPS (remote
mode), and a security password set on the Score machine with `scripts/score password`: a password set from a browser does not
unlock it. Opening a terminal asks for that password or a passkey every time; the shell runs as the user that runs Score.

## 7. Live mode against Hermes

Score talks to the Hermes gateway's API server. **(system: these write Hermes config.)**

```bash
# One key per Hermes profile; Score keeps its copies in ~/.score/hermes-keys/ (0600).
umask 077; mkdir -p ~/.score/hermes-keys
python3 -I -c 'import secrets;print(secrets.token_urlsafe(32))' > ~/.score/hermes-keys/default
hermes config set API_SERVER_KEY "$(cat ~/.score/hermes-keys/default)"     # enables the API server
hermes gateway restart
curl -s http://127.0.0.1:8642/v1/health                                    # {"status": "ok", ...}

# For every other profile Score should drive (no restart needed):
P=<profile>
python3 -I -c 'import secrets;print(secrets.token_urlsafe(32))' > ~/.score/hermes-keys/$P
hermes -p $P config set API_SERVER_KEY "$(cat ~/.score/hermes-keys/$P)"
```

Check that each profile's `model.default` is a model your provider actually serves
(`curl -s -H "Authorization: Bearer $(cat ~/.score/hermes-keys/default)" http://127.0.0.1:8642/api/model/options`).

Install the Score bridge plugin (Python, no runtime dependencies) into every profile Score should observe: follow
`hermes-plugin/README.md` (link or copy `hermes-plugin/score_bridge` into `<profile home>/plugins/score-bridge`, then
restart that profile's gateway). Then start Score with `SCORE_MODE=live pnpm dev`. From another machine, reach it through
an SSH tunnel (`ssh -N -L 5173:127.0.0.1:5173 <user>@<host>`); Score itself only listens on 127.0.0.1.

## 8. Creating agents from Score (Team › Add agent)

Score creates agents with `hermes profile create` and installs its bridge plugin into each one through
`hermes plugins install`, pinned to a URL and ref you choose. Set both before using **Add agent**:

```bash
export SCORE_BRIDGE_INSTALL_URL='file:///home/<you>/score#hermes-plugin/score_bridge'   # or https://<host>/<you>/score.git#hermes-plugin/score_bridge
export SCORE_BRIDGE_INSTALL_REF=<full 40-character commit hash>   # e.g. $(git -C ~/score rev-parse HEAD)
```

If Score runs with a custom `SCORE_HOME`, start Hermes with the same `SCORE_HOME`: the plugin reads its token and writes its spool there (default `~/.score`).

Without them, Add agent stops with "Configure a pinned bridge installation URL first." Agent management works on
this machine or over remote access (always HTTPS). Deleting an agent keeps a private
export in `$SCORE_HOME/profile-backups/` (it omits credentials and is not a full undo).

## 9. Run Score every day (built app, one port)
`pnpm dev` is for development. For daily use build once and serve everything from one loopback port:
```bash
pnpm build           # builds apps/web and typechecks the server
pnpm start           # http://127.0.0.1:8740 (SCORE_PORT to change); prints a one-time pairing link
```
`pnpm start` sets `SCORE_SERVE_WEB=1` (`NODE_ENV=production` does the same), so the server serves `apps/web/dist` and the API
on the same port, with SPA fallback. It runs the TypeScript sources through `tsx` (the same runner as `pnpm dev`). Set
`SCORE_MODE=live` for a real Hermes (default is `fake`).

Launcher (background process, PID file `$SCORE_HOME/score.pid`, log `$SCORE_HOME/score.log`):
```bash
scripts/score start     # start in the background and print the first pairing link
scripts/score status    # running? pid and URL
scripts/score pair      # mint a fresh pairing link (SIGUSR2 -> 0600 file in $SCORE_HOME; no network endpoint)
scripts/score password  # set or reset the security password (guards pairing, renewing and terminating devices)
scripts/score logs [-f] # last 100 log lines, or follow
scripts/score restart   # stop, then start (or `systemctl --user restart score` when installed as a service)
scripts/score stop
```
Put it on your PATH if you like: `ln -s "$PWD/scripts/score" ~/.local/bin/score`.

To run Score as a service instead, see 9a below. Once it is installed, `start`, `stop`, `restart` and
`status` act on the service, and `pair` and `logs` work as before.

### 9a. Run Score as a service (starts at boot, restarts after a crash)

The launcher installs a systemd **user** service, the same kind as `hermes-gateway.service`. Build first (`pnpm build`), set
the variables you normally start Score with, and run:
```bash
SCORE_MODE=live SCORE_REMOTE=1 SCORE_HOST=192.168.1.20 scripts/score service install
loginctl enable-linger "$USER"      # once: start at boot without a login (install warns when it is off)
scripts/score service status        # state, enabled, MainPID, URL, linger
```
`install` writes `~/.config/systemd/user/score.service` and a private environment file `~/.config/score/score.env` (mode 600)
holding `SCORE_HOME`, every `SCORE_*` variable set in the shell that ran `install`, and your `PATH` as it is then (systemd has
no shell `PATH`, and Score runs `hermes`, `git`, `tmux` and the coding CLIs from it). Nothing else from your environment is
copied. It then enables and starts the unit, waits for the server and prints the address and the pairing link. A
launcher-started Score must be stopped first (`scripts/score stop`): the two never run side by side.

- To change settings, run `install` again with the new variables: it rewrites both files, says which variables changed
  (names only) and restarts.
- After `git pull` and `pnpm build`: `scripts/score restart` (a clean stop drains for up to about 45 s).
- Logs: `scripts/score logs [-f]` (the unit appends to `$SCORE_HOME/score.log`); `journalctl --user -u score` shows systemd's own messages.
- If it keeps failing, systemd gives up after 5 starts in 5 minutes: read the log, fix the cause, then `scripts/score start`.
- Remove it: `scripts/score service uninstall` (keeps `score.env`; `--purge` deletes it too). The launcher then runs Score again.
- `scripts/score run` is the foreground form the unit uses; run it in a terminal to see Score's output directly.

Upgrades: stop Score (`scripts/score restart` after the build does stop and start in one step), back up `$SCORE_HOME` (at least `score.db`, `score.db-wal`/`-shm` if present, and `media/`), `git pull`,
`pnpm install && pnpm build`, start again. Migrations run automatically at start and are forward-only, so keep the backup
if you may want to go back to the previous version.

Knowledge vault (PLAN 6.2): notes live in `~/score-vault` (override with `SCORE_VAULT`), plain Markdown in a git repository
Score creates on first use. It needs `git` on the PATH; without it notes still save but there is no history. Back the folder
up like any other (it is the source of truth; Score's index of it is disposable). Fake mode uses a temporary seeded vault.

Do not `VACUUM` `score.db` by hand. The message search index (`message_fts`) is keyed on the implicit rowid of `messages`,
which a VACUUM may renumber. Score checks the index at every start and rebuilds it when it no longer matches, but a manual
VACUUM while Score runs can still leave search wrong until the next start.

### Orchestrations: the execution journal and restoring a backup (PLAN 7.5)

Orchestrations start Hermes runs on their own, so Score keeps an **execution journal** outside `$SCORE_HOME`:
`$SCORE_JOURNAL_DIR`, else `$XDG_STATE_HOME/score/execution-journal`, else `~/.local/state/score/execution-journal`
(fake mode keeps it inside the home; it starts no real runs). It records, before the effect, each admission, each run
handle Hermes returned and each Stop. On every start Score compares it with the database; anything the database lacks
(a database restored from a backup, a lost Stop), an unreadable journal, or a journal that vanished puts a **global
admission fence** on all orchestrations until you review the list in Settings and lift it. The journal is compacted daily
(only reconciled entries) and raises a size alarm at 50 MB.

**Restore `$SCORE_HOME` only with `scripts/score restore <backup-folder>`** (Score stopped; the folder must contain
`score.db`). It keeps the current home next to the restored one (`<home>.before-restore-<time>`) and leaves a marker so the
next start fences admission and marks execution history untrusted. A restore done any other way (copying files back by
hand, a filesystem rollback) on the same host and boot **cannot be detected**: Hermes runs Score started after the backup
was made are then unknown to Score and may still be running. This is the wording Settings › Backup repeats.

### Installation identity and the journal folders (PLAN 7.7a)

Each Score home has an **installation id** kept outside the home, in `<journal dir>/installations.json` (with a
`manifest.json` in each installation's own folder `<journal dir>/<id>/`, so a lost or damaged registry is rebuilt from the
manifests). The home keeps a copy in `installation.json`. The orchestration journal now lives in `<journal dir>/<id>/`
(`journal.ndjson`, its lock, `launches/` for coding-run receipts); the first start after the upgrade copies this home's
records out of the old shared `journal.ndjson` and writes a `cutover` record there (the old file stays as a read-only
witness; `scripts/score restore` follows the cutover). Nothing to do for you.

A home at a **path Score does not know** (a moved, renamed or copied folder) starts, but all orchestration and coding
admission is blocked and the fence cannot be lifted. Say which it is, with Score stopped:
`scripts/score installation confirm-move` (same installation, new folder: keeps its journal) or
`scripts/score installation confirm-copy` (a copy: gets its own id and its inherited run history is marked untrusted).
`scripts/score installation status` shows what the home and the registry say. If the registry is corrupt and no manifest
survives, Score refuses admission until you restore `installations.json` from a backup.

**When Score holds all agent work.** A confirmed copy, and a home whose execution journal is missing or holds less than the
database and the launch folders witnessed (deleted, replaced, truncated), freeze: no orchestration step is sent, no Stop is
delivered, no coding run is admitted or recovered, and no process is signalled. The fence screen and each coding agent's card
say "Score is holding all agent work: <why>. Run scripts/score installation reset-history to continue." Nothing is
reconciled or retired automatically in these states: Score can't tell what ran, and doing nothing can't repeat or misdirect
work. With Score stopped, `scripts/score installation reset-history` (it asks you to type `reset`; `--yes` skips the question
for scripts) retires every unfinished orchestration step, owed Stop, start request, coding process record and launch in the
database, moves the old journal and launch folders into `history-before-reset-<time>/` beside a fresh journal whose first
record is a permanent `history-reset`, and lifts the freeze. Nothing it retired is ever sent, stopped or signalled again, so
check Hermes and your coding services yourself for anything the old history started that may still be running.

### Coding runs as supervised services (PLAN 7.7a)

In live mode, every coding run (Claude Code, Codex, Antigravity) starts as a transient **systemd user service**
(`score-<first 8 characters of the installation id>-c-<launch id>.service`) with a small supervisor inside it. When Score
stops or crashes, the service stops the CLI and every process running inside it, and Score confirms from the service's
control group that nothing is left before it calls a run finished. Work a tool hands to another service, a scheduler or a
background daemon runs outside that group and isn't covered. It needs, on the host: a reachable user manager
(`systemctl --user`), cgroup v2, **linger** (`loginctl enable-linger $USER`, so the manager outlives your login), Python 3,
`systemd-notify`, `$XDG_RUNTIME_DIR` and a socket path under 100 bytes. Score checks all of this at start and shows the
result, with **Check again**, on each coding agent's card in Team.

**When the check doesn't pass.** The first time it passes, Score remembers that for this installation (a small file,
`unit-capable.json`, beside the journal in `<journal dir>/<id>/`, outside the home). From then on:
- A later failure (linger turned off, no user manager, no `$XDG_RUNTIME_DIR`) **pauses** coding agents. New coding
  messages are refused (`422 coding_paused`) and the card says what is missing and offers **Check again**. Score never
  falls back to the process-group engine behind your back on a host that has run supervised services. Fix the host and
  choose Check again; runs resume.
- An installation that has never passed (for example a host without a user manager at all) runs coding agents with the
  process-group engine and says so on the card: "tools a coding CLI started may keep running until Score restarts and
  stops them". That engine keeps its earlier limits: it signals the processes Score recorded for the run (through
  pidfds), not everything the CLI started, and its proof is the group, not a control group.
- There is no setting that forces the process-group engine in production (decision 70).
- Score saves the pass before it starts the first supervised service. If the file can't be written (disk full), coding
  stays paused and Score retries the write; it also recognises an installation that has run supervised services from
  its journal and database, so losing the file doesn't re-open the process-group engine.
- Restore, journal and installation uncertainty (an unresolved fence in Score) stops every coding launch, whichever
  engine would run it, also at the moment of release.

Receipts and the single-use spec files live outside the home (`<journal dir>/<id>/launches/…`,
`$XDG_RUNTIME_DIR/score/<id8>/launches/…`). To inspect a stuck service: `systemctl --user list-units 'score-*-c-*'`.

Tests: `SCORE_TEST_SYSTEMD=1 pnpm --filter @score/server test coding-units-systemd coding-systemd` runs the opt-in suite
against the real user manager. Its units are named `score-test-<random>-…` and always stopped and reset by the test.

## Changelog of this file
- 2026-10-12: no production switch for the process-group engine; the pass is saved before any unit launch (decision 70).
- 2026-10-12: supervised services are the only engine once an installation has passed the check; a later failure pauses coding (decision 69).
- 2026-10-12: coding runs as supervised services, capability check, `SCORE_CODING_BACKEND` (PLAN 7.7a part 3).
- 2026-10-12: installation identity, per-installation journal folders, `score installation` (PLAN 7.7a part 1).
- 2026-10-10: orchestrations: execution journal location and `scripts/score restore` (PLAN 7.5a).
- 2026-10-09: do not VACUUM by hand (search index rebuilt at start).- 2026-10-09: the knowledge vault (`SCORE_VAULT`, git).
- 2026-10-08: section 9, running the built app (pnpm start, launcher, systemd unit).
- 2026-10-08: creating agents (bridge install URL/ref).
- 2026-10-08: bridge plugin install pointer, live start and SSH tunnel.
- 2026-10-06: initial (Phase 0).
- 2026-10-06: live-mode steps verified (per-profile API keys).
- 2026-10-07: uv 0.12.23 (user-local, checksum-verified) for hermes-plugin/.

`SCORE_PRINT_PAIR_LINK=1` makes the server print its startup pairing link to a non-terminal stdout (dev tooling and the
e2e specs read it from a log). Without it a terminal gets the link and anything else (the launcher's `score.log`) gets a
line without it; the launcher shows the link once from a 0600 `pair-link` file and deletes it.

## Coding agents (PLAN 7.2, optional)
Team › Add agent › Coding agent runs the CLIs you already have, signed in with their own logins (Score never reads or
passes credentials): `claude` (Claude Code, tested with exactly 2.1.295) and `codex` (Codex CLI, tested with exactly 0.160.1). Both must be
on the `PATH` Score starts with. A newer or older version shows "untested version" and runs only after you confirm it for that
agent. Turns use your Claude / ChatGPT plan quota. Tests and the fake mode never start a
real CLI: `SCORE_CODING_FAKE_CLI` (honoured only in fake mode and under test) points at a script that prints hand-made fixtures.
