# AGENTS.md: rules for every coding agent on Score

This file is the single source of truth for any agent (Claude, Codex, Gemini, …) writing code here.
If something here conflicts with another doc, this file wins. Raise the conflict instead of guessing.

## What Score is
A local-first web app for running a team of Hermes Agent profiles: live timeline (Score), node graph (Flow),
event replay (Watch), Chat rooms with @mention hand-offs, Kanban Tasks, Team pages, Reports and Settings.
Read `docs/ARCHITECTURE.md` before structural work and `docs/PLAN.md` for the task you are on.

## Before you touch the boundary
**Read `docs/API-CONTRACT.md` before changing anything that crosses web ↔ server.** The front end may use only
the endpoints and events in that contract. If you need something new, update the contract doc first, then
`packages/contract`, then both sides, in the same change.

Hermes access lives behind two boundaries (ARCHITECTURE D2.1):
- **Node:** `apps/server/src/hermes/`. Nothing else may import Hermes paths, URLs, CLI verbs or event names.
- **Python:** `hermes-plugin/score_bridge/`. Every call into private Hermes functions lives in
  `score_bridge/hermes_private.py` and nowhere else.

Never read `~/.hermes/.env`, `auth.json` or any credential file. Never write Hermes SQLite databases: open them
read-only and write through the `hermes` CLI or the gateway API. The only file-write exception is `SOUL.md` and
`AGENTS.md` inside a profile directory, via the adapter's atomic, etag-checked writer (D2.6). Redact before
storing anything that came from a hook (D6).

## Stack
- Node 24 (≥ 22.22.2), pnpm 12 workspaces, TypeScript 6 (strict), ESM everywhere.
- `apps/web`: React 19, Vite 8, React Router, TanStack Query. Plain CSS with custom-property tokens
  (`src/styles/tokens.css`); no CSS framework. Fonts from `@fontsource/*` only (never Google Fonts at runtime).
- `apps/server`: Fastify 5, zod, `node:sqlite` (Score's own DB at `$SCORE_HOME`, default `~/.score`).
- `packages/contract`: zod schemas + types mirroring `docs/API-CONTRACT.md`.
- `hermes-plugin/` (Phase 1+): Python Hermes plugin `score_bridge`, managed with `uv`, tested with pytest.

## Folder layout
```
apps/web/src/        routes/<destination>/…, components/, data/ (stream + queries), styles/
apps/server/src/     app.ts, http/ (routes), hub/ (event stream), domain/, db/, hermes/ (adapter: live/, fake/)
apps/server/migrations/   forward-only SQL, NNNN_name.sql
packages/contract/src/    one file per contract section
e2e/                 Playwright specs (run against the fake adapter)
scripts/             repo tooling (license check, …)
docs/                plan, architecture, contract, setup, spike, design references
```

## Naming
- Files: `kebab-case.ts`; React components `PascalCase.tsx` exporting a named component of the same name.
- Types and schemas: `PascalCase` (`TaskSummary`, `TaskSummarySchema`). Functions and variables: `camelCase`.
- Stream event types: `noun.verb` in the past tense (`task.upserted`, `approval.resolved`).
- REST paths: plural nouns, kebab-case (`/api/tool-servers`), actions as `POST …/actions` or a sub-resource.
- No default exports except where a tool requires one (config files).

## Code style
- Prettier (`pnpm format`) and ESLint (`pnpm lint`) must pass. No `any` without a comment saying why.
- Validate every external input with zod at the edge (HTTP bodies, bridge payloads, CLI output, SQLite rows).
- Spawn processes with `execFile`/`spawn` and argument arrays. Never use a shell string.
- Keep modules small and pure where possible; side effects go at the edges (http/, hermes/live/, db/).
- Match the surrounding code's comment density. Comments explain *why*, not *what*.

## Testing
- Every task ships with tests; the task's "done when" criteria in `docs/PLAN.md` are the acceptance tests.
- Unit and integration: Vitest (`pnpm test`, or `pnpm --filter <pkg> test`). Server routes are tested with
  Fastify `inject()`.
- E2E: Playwright (`pnpm e2e`) against `SCORE_MODE=fake`, on the production build (`SCORE_E2E_DEV=1` uses the Vite dev
  server instead). Never against a live Hermes, and never spending model tokens.
- Hermes behaviour is tested with recorded fixtures (`apps/server/test/fixtures/`). Never hit a live Hermes in tests.
- Before you say a task is done: `pnpm check` (lint + format + typecheck + test + license) is green.

## Dependency rules
- Project-local installs are fine (`pnpm add <pkg>@<exact>`, `uv add` in `hermes-plugin/`). Pin exact
  versions (`savePrefix: ''`). Commit the lockfile with the change that adds the dependency.
- **Check the license before adding**, including obvious transitive surprises (`pnpm why`, `npm view <pkg> license`).
- Anything system-level or global (sudo, apt/dnf, `npm -g`, shell profiles, `~/.hermes` config): **don't**.
  Describe the exact command and why, and stop for the owner's OK.
- Install scripts are disabled by default (`allowBuilds` in `pnpm-workspace.yaml`). Enabling one needs a reason.
- Prefer no dependency over a small one. Every dependency needs a one-line reason in the PR/task log.
- Record new prerequisites or setup steps in `docs/SETUP.md`.

## Licensing rules (non-negotiable)
1. Score is licensed under **PolyForm Noncommercial 1.0.0** (`LICENSE.md`, `NOTICE`; commercial use needs a separate
   license, see `COMMERCIAL.md`; owner decision 2026-10-08). The owner must be able to relicense it commercially, so
   all code stays ours or MIT-compatible.
2. You MAY read, copy and adapt code from these MIT sources, cloned **outside** this repo in `../reference/`:
   JPeetz/Hermes-Studio, outsourc-e/hermes-workspace, NousResearch/hermes-agent,
   NousResearch/hermes-example-plugins, nesquena/hermes-webui (MIT, added by the owner 2026-10-09). When you copy or closely adapt code, add the source file path and its
   copyright notice to `THIRD_PARTY_NOTICES.md` and leave a one-line comment at the top of the adapted code.
   Never clone them inside this repo.
3. **Never read, fetch, search for or reproduce code from EKKOLearnAI/ekko-studio** (formerly hermes-web-ui /
   "Hermes Studio" by EKKOLearnAI). It is BSL-licensed. If the owner describes its behaviour, build from the
   description only.
4. Every dependency must be MIT, Apache-2.0, BSD (2/3-clause) or ISC. Fonts: SIL OFL-1.1. Anything else must be
   flagged to the owner **before** it is added. `pnpm license:check` enforces this; approved exceptions live in
   `license-exceptions.json` (owner approval only, exact `name@version`).
5. Do not ship the owner's persona names (Akeno, Fern, Makima, Marin) or any character art as defaults, fixtures,
   seeds or screenshots in tests. Ship neutral example agents: `lead`, `builder`, `reviewer`, `designer`.
   The PNGs in `docs/design/` show personas and are reference-only.

## Design rules
- `docs/design/*.png` and their standalone versions in `docs/design/html/` are the source of truth for layout
  and look. Take exact colors, radii and spacing from the HTML (inline styles; fonts are embedded there, but the
  app must load them from `@fontsource`). `docs/design/**/theme-only/` is a Hermes-dashboard skin, out of scope.
- Ground `#ECEEF2`; white cards with ~28px radius; ink `#12131A` for primary actions and anything that needs
  the user. Headings: Bricolage Grotesque; body: Hanken Grotesk; code: JetBrains Mono.
- Agents are always identified by **color + shape**, never color alone. Use `AgentGlyph`.
- Watch is an event replay, not a remote desktop.

## Git
- Default branch `main`. One task per branch (`task/<plan-id>-<slug>`), small commits, imperative messages.
- Don't commit secrets, `.env` files, `~/.score` data or anything from `../reference/`.
