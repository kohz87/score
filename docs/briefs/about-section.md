# Settings › About: version and update check (decision 79)

Owner request 2026-10-14. One builder, branch `task/about` (worktree `../score-worktrees/about`), failing-first tests.

## Contract (docs/API-CONTRACT.md first, then packages/contract)
- `GET /api/about` → `About { version: string /* package.json */; commit: string | null /* short git commit of the
  running checkout, read once at start with execFile git rev-parse; null if not a git checkout */; schema: number;
  contract: number; hermes: { version: string } | null; node: string; mode: 'live' | 'fake'; repository: string /*
  https URL */; checkout: string /* the folder the server runs from, for the update steps */ }`.
- **H** `POST /api/about/update-check` → `UpdateCheck { checkedAt; current: string; status: 'up_to_date' |
  'update_available' | 'ahead' | 'unavailable'; latest: { version; tag; url /* release/tag page */; changelogUrl } |
  null; message: string /* plain words, WRITING.md */ }`. Only on request; rate-limited (one check per 60 s, else the
  last answer is returned).

## Server
- The check reads the public tag list (`https://api.github.com/repos/<owner/repo>/tags?per_page=100`; repo from
  `SCORE_UPDATE_REPO`, default `kohz87/score`), 10 s timeout, `User-Agent: Score/<version>`, no credentials, no data
  about the person; picks the highest `vX.Y.Z` tag (semver compare, pre-releases ignored). Failure ⇒ `unavailable` with
  a plain message ("Couldn't reach GitHub. Check your connection and try again."). Validate the response with zod.
- The fetcher is injected; **tests never touch the network**. Fake mode returns a fixed answer.
- Never called in the background, at start or on page load.

## Web: Settings › About
- A section "About Score" (look from docs/design, settings.css): the version as the heading line, then commit, schema,
  contract, Hermes, Node, mode; the repository link.
- Button **Check for updates** → result line: "You're up to date (v1.3.0)." / "v1.4.0 is available." with links
  "What's new" (changelog) and the release page / "This build is newer than the latest release." / the unavailable text.
- When an update is available, the steps (copyable, mono): back up first (link to Settings › Backups), then
  `cd <checkout>`, `git pull --ff-only`, `pnpm install --frozen-lockfile`, `pnpm build`, `scripts/score stop`, then
  "start Score again the way you usually do" (the start command isn't known to the page; don't guess env vars).
- Plain words throughout (WRITING.md, British spelling, sentence case).

## Tests
Server routes with inject() and a fake fetcher (up to date, update available, ahead, network error, malformed answer,
rate limit); web component tests; one e2e in fake mode (open About, click Check for updates, see the result). `pnpm
check`, full e2e (SCORE_WEB_PORT=5492 — another builder uses 5491).
