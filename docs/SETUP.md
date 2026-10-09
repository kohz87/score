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
scripts/score stop
```
Put it on your PATH if you like: `ln -s "$PWD/scripts/score" ~/.local/bin/score`.

systemd user unit (not installed by Score): copy `docs/score.service.example` to `~/.config/systemd/user/score.service`,
edit `WorkingDirectory`, then `systemctl --user enable --now score`. Use either the launcher or systemd for one `SCORE_HOME`, not both.

Upgrades: stop Score, back up `$SCORE_HOME` (at least `score.db`, `score.db-wal`/`-shm` if present, and `media/`), `git pull`,
`pnpm install && pnpm build`, start again. Migrations run automatically at start and are forward-only, so keep the backup
if you may want to go back to the previous version.

Knowledge vault (PLAN 6.2): notes live in `~/score-vault` (override with `SCORE_VAULT`), plain Markdown in a git repository
Score creates on first use. It needs `git` on the PATH; without it notes still save but there is no history. Back the folder
up like any other (it is the source of truth; Score's index of it is disposable). Fake mode uses a temporary seeded vault.

## Changelog of this file
- 2026-10-09: the knowledge vault (`SCORE_VAULT`, git).
- 2026-10-08: section 9, running the built app (pnpm start, launcher, systemd unit).
- 2026-10-08: creating agents (bridge install URL/ref).
- 2026-10-08: bridge plugin install pointer, live start and SSH tunnel.
- 2026-10-06: initial (Phase 0).
- 2026-10-06: live-mode steps verified (per-profile API keys).
- 2026-10-07: uv 0.12.23 (user-local, checksum-verified) for hermes-plugin/.

`SCORE_PRINT_PAIR_LINK=1` makes the server print its startup pairing link to a non-terminal stdout (dev tooling and the
e2e specs read it from a log). Without it a terminal gets the link and anything else (the launcher's `score.log`) gets a
line without it; the launcher shows the link once from a 0600 `pair-link` file and deletes it.
