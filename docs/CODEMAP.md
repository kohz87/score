# Score code map

Use this map before searching the tree. Each section lists source folders first, then the files most
likely to be the entry point for a change.

## I want to change …

- App startup, routing or shell choice → `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- The bold frame, navigation or screen shell → `apps/web/src/bold/BoldShell.tsx`
- A bold screen → `apps/web/src/bold/`
- The team room, messages or needs-you cards → `apps/web/src/bold/room/`
- Starting a job → `apps/web/src/bold/BoldStartJob.tsx`, `apps/web/src/bold/bold-start-job.ts`
- Chat messages or the composer → `apps/web/src/routes/chat/`
- The live browser stream → `apps/web/src/data/stream.ts`
- API calls and cache keys → `apps/web/src/data/api.ts`, `apps/web/src/data/query-client.ts`
- Styles, tokens or protected surfaces → `apps/web/src/styles/`
- Themes and the customizer → `apps/web/src/themes/`, `apps/server/src/themes/`
- Knowledge notes and files → `apps/web/src/routes/knowledge/`, `apps/server/src/knowledge/`
- Workflows and orchestration runs → `apps/web/src/routes/workflows/`, `apps/server/src/domain/workflows/`
- The orchestration executor → `apps/server/src/domain/orchestration/executor.ts`
- A server API route → `apps/server/src/http/`
- Server startup and route registration → `apps/server/src/index.ts`, `apps/server/src/start-server.ts`, `apps/server/src/app.ts`
- Live event ingest and fan-out → `apps/server/src/hub/`
- The Hermes adapter boundary → `apps/server/src/hermes/index.ts`
- Fake Hermes for tests and e2e → `apps/server/src/hermes/fake/`
- The Python bridge plugin → `hermes-plugin/score_bridge/`
- A shared request or event schema → `packages/contract/src/`
- A database migration → `apps/server/migrations/`
- Repo checks and tooling → `scripts/`
- Browser end-to-end coverage → `e2e/`

## apps/web/src

### Folders

- `apps/web/src/` — SPA bootstrap, root router and the classic/bold shell choice.
- `apps/web/src/bold/` — the new dark shell: screens, navigation, room, look and bold-only styles.
- `apps/web/src/bold/agent-more/` — per-agent detail cards for settings, access, routines and removal.
- `apps/web/src/bold/chats/` — bold chat list, chat information and run controls.
- `apps/web/src/bold/direct/` — one-to-one chat with an agent.
- `apps/web/src/bold/jobmap/` — job map and step graph for a running job.
- `apps/web/src/bold/room/` — team room, message stream, needs-you cards, menus and room state.
- `apps/web/src/bold/take-over/` — leased Hermes bot desktop screen and input handling.
- `apps/web/src/components/` — shared UI: agent identity, glyphs, model pickers, editor and uploads.
- `apps/web/src/components/flow-layout/` — workflow node placement helpers.
- `apps/web/src/components/model-settings/` — model aliases, effort, speech and fallback controls.
- `apps/web/src/data/` — REST and SSE clients, session, query helpers and app-wide data utilities.
- `apps/web/src/live/` — live status, activity and recently-resolved widgets.
- `apps/web/src/motion/` — animation helpers and arrival/tween components.
- `apps/web/src/notifications/` — browser notifications, preferences and click routing.
- `apps/web/src/pwa/` — service worker and update banner.
- `apps/web/src/routes/` — destination pages mounted by the app router.
- `apps/web/src/routes/attempts/` — attempt detail and replay page.
- `apps/web/src/routes/chat/` — classic chat page, composer, message rendering and chat dialogs.
- `apps/web/src/routes/customizer/` — theme customizer and its live preview.
- `apps/web/src/routes/knowledge/` — knowledge browser, note editor, files, images and tables.
- `apps/web/src/routes/orchestrations/` — orchestration run panels, decisions and live diagram.
- `apps/web/src/routes/pair/` — pairing and sign-in page.
- `apps/web/src/routes/reports/` — reports pages and journey chart.
- `apps/web/src/routes/runs/` — helpers for opening a brief as a run.
- `apps/web/src/routes/settings/` — settings sections for providers, logs, backup and notifications.
- `apps/web/src/routes/team/` — team and agent pages, coding agent, model and workspace tabs.
- `apps/web/src/routes/terminal/` — browser terminal page and key handling.
- `apps/web/src/routes/watch/` — watch replay timeline, stage and replay model.
- `apps/web/src/routes/workflows/` — workflow editor, nodes, runs, recipes and previews.
- `apps/web/src/shell/` — classic-shell navigation and frame helpers.
- `apps/web/src/styles/` — global tokens, select and protected styles, built-in packs.
- `apps/web/src/styles/packs/` — dense, night and paper display packs.
- `apps/web/src/test/` — web test setup, controlled XHR and shared fixtures.
- `apps/web/src/themes/` — theme engine, look runtime, contrast, sanitising and guards.
- `apps/web/src/themes/customizer/` — customizer draft, package, zip, save and measurement helpers.

### Key files

- `apps/web/src/main.tsx` — browser bootstrap: routers, providers, stream, theme and service worker.
- `apps/web/src/App.tsx` — route table and classic/bold shell choice.
- `apps/web/src/bold/BoldShell.tsx` — bold frame, navigation and route outlet.
- `apps/web/src/bold/BoldStartJob.tsx` — start-job flow entry and screen.
- `apps/web/src/bold/bold-start-job.ts` — start-job model and request shaping.
- `apps/web/src/bold/room/BoldTeamRoom.tsx` — team room composition.
- `apps/web/src/bold/room/RoomMessageStream.tsx` — room message stream rendering and follow behaviour.
- `apps/web/src/bold/room/RoomMenus.tsx` — room and message action menus.
- `apps/web/src/bold/room/use-needs-you.ts` — needs-you selection and state.
- `apps/web/src/bold/room/bold-room.css` — team-room styles.
- `apps/web/src/data/api.ts` — API request wrapper and session handling.
- `apps/web/src/data/stream.ts` — resumable browser SSE client.
- `apps/web/src/data/query-client.ts` — query client and stream context.
- `apps/web/src/routes/chat/Composer.tsx` — classic chat composer and send flow.
- `apps/web/src/routes/chat/MessageItem.tsx` — chat message rendering.
- `apps/web/src/routes/team/CodingAgent.tsx` — coding-agent detail page.
- `apps/web/src/routes/knowledge/NoteWorkspace.tsx` — note editor workspace.
- `apps/web/src/routes/watch/watch-model.ts` — watch timeline and replay model.
- `apps/web/src/themes/guard.ts` — protected-surface and theme guard.
- `apps/web/src/styles/protected.css` — surfaces that themes may never hide or fake.
- `apps/web/src/components/AgentGlyph.tsx` — agent colour-and-shape identity.

## apps/server/src

### Folders

- `apps/server/src/` — Fastify bootstrap, configuration and app composition.
- `apps/server/src/auth/` — pairing, sessions, passkeys, CSRF, passwords and remote security.
- `apps/server/src/db/` — Score SQLite open, migrate, lock, FTS and epochs.
- `apps/server/src/domain/` — room, task, approval, report, profile and other domain rules.
- `apps/server/src/domain/exchanges/` — exchange requests, budgets, results and workbench state.
- `apps/server/src/domain/orchestration/` — orchestrator state, executor, journal, fences and checks.
- `apps/server/src/domain/triggers/` — webhook triggers, signatures, queue and report-back.
- `apps/server/src/domain/workflows/` — workflow definitions, planner, runs and views.
- `apps/server/src/hermes/` — the Node-side Hermes boundary and its public adapter surface.
- `apps/server/src/hermes/bridge/` — Python bridge producers, routes, ingest and retention.
- `apps/server/src/hermes/fake/` — scripted fake Hermes for development, tests and e2e.
- `apps/server/src/hermes/live/` — live Hermes adapter: gateway, SQLite, CLI, profiles and tasks.
- `apps/server/src/hermes/live/kanban-attempts/` — read, project and associate Kanban attempts.
- `apps/server/src/http/` — API routes, one file per contract section.
- `apps/server/src/hub/` — ordered event ingest, projections, SSE fan-out, snapshots and retention.
- `apps/server/src/knowledge/` — vault files, notes, extraction, links, export and staging.
- `apps/server/src/locks/` — OS-level lock helpers.
- `apps/server/src/mcp/` — MCP access control, routes and tools.
- `apps/server/src/media/` — upload storage, multipart parsing and type sniffing.
- `apps/server/src/runtimes/` — agent runtime implementations.
- `apps/server/src/runtimes/check/` — spawn-based check command runner.
- `apps/server/src/runtimes/coding/` — coding-agent drivers, process supervisor, units, quotas and the split coding runtime service.
- `apps/server/src/shares/` — public share pages, markdown and rate limits.
- `apps/server/src/terminal/` — PTY terminal manager, tickets and environment.
- `apps/server/src/themes/` — theme packages, built-ins, CSS validation and storage.
- `apps/server/src/workspace/` — workspace roots, git, policy and per-agent workspaces.
- `apps/server/migrations/` — forward-only numbered SQL migrations.
- `apps/server/scripts/` — server maintenance scripts.

### Key files

- `apps/server/src/index.ts` — process entry and signal handling.
- `apps/server/src/start-server.ts` — server, database, adapter and background services wiring.
- `apps/server/src/app.ts` — Fastify app and route registration.
- `apps/server/src/config.ts` — environment configuration.
- `apps/server/src/db/index.ts` — database open and migration surface.
- `apps/server/src/hub/ingest.ts` — the single ordered event ingest path.
- `apps/server/src/hub/sse.ts` — browser SSE endpoint and fan-out.
- `apps/server/src/http/rooms.ts` — room, message and room-action routes.
- `apps/server/src/http/stream.ts` — stream route.
- `apps/server/src/domain/orchestration/executor.ts` — orchestrator execution.
- `apps/server/src/domain/orchestration/fence.ts` — decision fences and turn ownership.
- `apps/server/src/domain/exchanges/apply.ts` — applies accepted exchange results.
- `apps/server/src/hermes/index.ts` — the only server entry into Hermes code.
- `apps/server/src/hermes/port.ts` — Hermes adapter interface.
- `apps/server/src/hermes/live/live-port.ts` — live Hermes adapter.
- `apps/server/src/hermes/live/gateway.ts` — Hermes gateway client.
- `apps/server/src/hermes/live/sqlite.ts` — read-only Hermes SQLite access.
- `apps/server/src/hermes/fake/fake-port.ts` — fake Hermes adapter.
- `apps/server/src/knowledge/vault.ts` — knowledge vault operations.
- `apps/server/src/runtimes/coding/service.ts` — public coding runtime import path and re-export facade.
- `apps/server/src/runtimes/coding/service-types.ts` — coding runtime dependencies, run/attempt types, row schemas and shared helpers.
- `apps/server/src/runtimes/coding/service-base.ts` — shared runtime state, backend status, accessors and shutdown assertion.
- `apps/server/src/runtimes/coding/service-cli.ts` — CLI refusal, version/help checks and policy deny lists.
- `apps/server/src/runtimes/coding/service-processes.ts` — process/member records, reaping, held groups and release.
- `apps/server/src/runtimes/coding/service-views.ts` — agent views/details, quota readings and model listings.
- `apps/server/src/runtimes/coding/service-workers.ts` — coding-worker facts, reports and policy checks.
- `apps/server/src/runtimes/coding/service-delivery.ts` — durable terminal-result delivery and retry.
- `apps/server/src/runtimes/coding/service-launch.ts` — room/job helpers, run wrapper and unit/process launch attempts.
- `apps/server/src/runtimes/coding/service-execution.ts` — the per-turn preparation, attempt loop and terminal decision.
- `apps/server/src/runtimes/coding/service-admission.ts` — idempotent run admission and unresolved-run checks.
- `apps/server/src/runtimes/coding/service-stops.ts` — Stop controls for live, recorded and queued runs.
- `apps/server/src/runtimes/coding/service-recovery.ts` — restart recovery, shutdown and the final `CodingRuntime` class.
- `apps/server/src/runtimes/coding/units.ts` — coding unit lifecycle.

## packages/contract/src

### Folders

- `packages/contract/src/` — shared zod schemas and types for every HTTP endpoint and stream event.

### Key files

- `packages/contract/src/index.ts` — public contract exports and version.
- `packages/contract/src/http.ts` — HTTP envelopes and shared request/response pieces.
- `packages/contract/src/stream.ts` — stream event types and envelopes.
- `packages/contract/src/bridge.ts` — Python bridge payloads.
- `packages/contract/src/types.ts` — shared domain types.
- `packages/contract/src/orchestration.ts` — orchestration schemas and types.
- `packages/contract/src/workflows.ts` — workflow schemas and types.
- `packages/contract/src/themes.ts` — theme schemas and types.

## hermes-plugin/score_bridge

### Folders

- `hermes-plugin/score_bridge/` — fail-open Hermes plugin: hooks, outbound sender, decisions and spool.

### Key files

- `hermes-plugin/score_bridge/__init__.py` — plugin entry and Hermes hook registration.
- `hermes-plugin/score_bridge/sender.py` — event batching and delivery.
- `hermes-plugin/score_bridge/client.py` — HTTP client for Score.
- `hermes-plugin/score_bridge/spool.py` — bounded on-disk spool for failed delivery.
- `hermes-plugin/score_bridge/hermes_private.py` — the only calls into private Hermes functions.
- `hermes-plugin/score_bridge/approvals.py` — gateway approval handling.
- `hermes-plugin/score_bridge/decisions.py` — decision delivery.
- `hermes-plugin/score_bridge/redact.py` — redaction before anything leaves a hook.
- `hermes-plugin/score_bridge/exchanges.py` — exchange tools exposed to agents.

## scripts

### Folders

- `scripts/` — repo checks, launchers, comparison tools and maintenance commands.
- `scripts/compare/` — screen comparisons against the bold prototype boards.
- `scripts/perf/` — Playwright performance configuration and specs.

### Key files

- `scripts/structure-check.mjs` — size-exception and code-map enforcement.
- `scripts/size-exceptions.json` — the shrinking list of files still over 450 lines.
- `scripts/license-check.mjs` — dependency license gate.
- `scripts/license-policy.mjs` — allowed license policy.
- `scripts/start.mjs` — production launcher for the built app.
- `scripts/restore.mjs` — backup restore command.
- `scripts/capacity.mjs` — machine load report.
- `scripts/set-password.mjs` — security-password setter.
- `scripts/codex-task.sh` — task worktree launcher.
- `scripts/load-test.ts` — local load test entry.

## e2e

### Folders

- `e2e/` — Playwright specs and shared fixtures run against the fake adapter.
- `e2e/readme/` — README screenshot configuration and spec.

### Key files

- `playwright.config.ts` — main end-to-end configuration.
- `e2e/bold-room-fixtures.ts` — rooms and agents used by bold-room specs.
- `e2e/themes-fixtures.ts` — theme packages and screenshots used by theme specs.
- `e2e/visual-fixtures.ts` — shared visual-test setup.
- `e2e/workflow-fixtures.ts` — workflow definitions and runs for e2e.
- `e2e/locks.ts` — cross-worker test locks.
- `e2e/global-teardown.ts` — shared fake-server teardown.
- `e2e/now-fixture.ts` — deterministic clock fixture.
