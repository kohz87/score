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

The Score bridge plugin (Python, managed with `uv`) gets its install steps here when Phase 1 task 1.13 lands.

## Changelog of this file
- 2026-10-06: initial (Phase 0).
- 2026-10-06: live-mode steps verified (per-profile API keys).
- 2026-10-07: uv 0.12.23 (user-local, checksum-verified) for hermes-plugin/.
