# Score plan

Every task is ≤ half a day. Owners: **Lead** (Claude: lead/integrator), **Codex** (isolated tasks via the
codex plugin; brief must include the goal, the "done when" criteria, the relevant API-CONTRACT section and "follow
AGENTS.md"), **Gemini** (whole-repo review, run manually by you).

Rules for every task: after it lands, `/codex:review --background`. Before merging a phase, run
`/codex:review --base main` and the phase-gate Gemini review. Rejected review findings are noted in the task log
(`docs/TASKLOG.md`) with the reason.

Test commands: `pnpm test` (Vitest, all packages), `pnpm typecheck`, `pnpm lint`, `pnpm e2e` (Playwright vs.
fake adapter), `pnpm check` (= lint + typecheck + test + license), `uv run pytest` (in `hermes-plugin/`).

---

## Phase 0: Setup and plan ✅ (this phase)
Toolchain, reference study, spike, architecture, contract, plan, AGENTS.md / CLAUDE.md, empty scaffold.
Open items: Codex plugin enablement, the architecture adversarial review, and live tests L1–L5 (all need you).

## Phase 1: Foundation

**1.1 Contract package: shared types** · Lead
- Goal: zod schemas + inferred TS types for API-CONTRACT §1 (shared types) and §2 (stream envelope + event union).
- Files: `packages/contract/src/{types,stream,index}.ts`, `packages/contract/test/*.test.ts`
- Done when: every type in §1–§2 has a schema; round-trip tests pass for one fixture per type; `apps/*` import from `@score/contract`.
- Test: `pnpm --filter @score/contract test`

**1.2 Server skeleton** · Lead
- Goal: Fastify app factory, config (`SCORE_HOME`, port, mode), `GET /api/system` (fake data), error shape, CSRF header guard.
- Files: `apps/server/src/{app,config,errors}.ts`, `apps/server/src/http/system.ts`, tests
- Done when: `inject()` tests cover 200, 400 error shape, 403 on a mutating request without `X-Score-Client`.
- Test: `pnpm --filter @score/server test`

**1.3 score.db + migrations** · Lead
- Goal: `node:sqlite` wrapper, forward-only SQL migrations, `events` table.
- Files: `apps/server/src/db/{index,migrate}.ts`, `apps/server/migrations/0001_events.sql`
- Done when: fresh DB migrates; re-run is a no-op; tests use a temp dir.
- Test: `pnpm --filter @score/server test -- db`

**1.4 Event hub + `/api/stream`** · Lead · *adversarial review before merge*
- Goal: persist → seq → fan-out; SSE endpoint with `since`, `Last-Event-ID`, heartbeat, `stream.reset` on prune/overflow, per-client queue cap.
- Files: `apps/server/src/hub/{hub,sse}.ts`, `apps/server/src/http/stream.ts`, tests
- Done when: tests prove no gap/no duplicate across reconnect; slow client gets reset without blocking others; retention prune works.
- Test: `pnpm --filter @score/server test -- hub`

**1.5 HermesPort + fake adapter** · Lead
- Goal: the adapter interface (API-CONTRACT-shaped domain calls + event emitter) and a scripted fake with the four neutral agents (lead, builder, reviewer, designer) running a small scenario on a clock.
- Files: `apps/server/src/hermes/{port,index}.ts`, `apps/server/src/hermes/fake/*`
- Done when: `SCORE_MODE=fake pnpm dev` streams scenario events; lint rule blocks importing `hermes/*` internals elsewhere.
- Test: `pnpm --filter @score/server test -- fake`

**1.6 Web shell** · Lead
- Goal: tokens (CSS vars), @fontsource fonts, top nav (6 destinations + "Now" dot), route stubs, ⌘K stub, avatar.
- Files: `apps/web/src/{main,App}.tsx`, `apps/web/src/styles/tokens.css`, `apps/web/src/shell/*`
- Done when: each route renders its title; no network requests to font CDNs (asserted in e2e); matches the nav in `docs/design/*.png`.
- Token source: `docs/design/html/*.html` inline styles. Most-used values: ink #12131A, muted #5E626C / #6E727C, hairline #DFE2E8, ground #ECEEF2, subtle #F4F5F8; agent tints #ECE8FF / #DDF6EE / #FFF1D1 / #FFE3E9 with text #4A2FD9 / #00694F / #8A5A00; radii 999px (pills), 28px (cards), 20/16/14/8px.
- Test: `pnpm --filter @score/web test && pnpm e2e -- shell`

**1.7 `useStream` + Query cache patching** · Lead
- Goal: one EventSource per tab, resume, `stream.reset` → invalidate; typed event dispatch to Query cache updaters.
- Files: `apps/web/src/data/{stream,queryClient}.ts`, tests with a mock EventSource
- Done when: reconnect resumes from the last seq; reset triggers refetch; unknown event types are ignored and logged.
- Test: `pnpm --filter @score/web test -- stream`

**1.8 AgentGlyph component** · Codex
- Goal: render an agent as color + shape (8 shapes), sizes S/M/L, with an accessible name and high-contrast outline mode.
- Files: `apps/web/src/components/AgentGlyph.tsx` + test
- Done when: snapshot per shape; `aria-label` includes the agent name; never color-only (shape visible in grayscale test).
- Test: `pnpm --filter @score/web test -- AgentGlyph`

**1.9 Live adapter: SQLite readers** · Lead
- Goal: read-only readers for kanban.db (tasks, runs, events, links) and state.db (sessions, messages, usage); tail by `(created_at, id)`.
- Files: `apps/server/src/hermes/live/{sqlite,kanban,sessions}.ts`, fixtures built from `docs/spike/*-schema.sql`
- Done when: tests against fixture DBs cover tailing with same-millisecond rows; opening uses `mode=ro`.
- Test: `pnpm --filter @score/server test -- live/sqlite`

**1.10 Upstream SSE client** · Codex
- Goal: robust SSE parser/client (multi-line `data:`, comments, `id:`, retry, resume with `Last-Event-ID`, abort).
- Files: `apps/server/src/hermes/live/sse-client.ts` + tests
- Done when: spec-conformance tests (WHATWG event-stream parsing cases) pass; resume test against a local test server.
- Test: `pnpm --filter @score/server test -- sse-client`

**1.11 Live adapter: gateway runs** · Lead
- Goal: start/stop/steer runs on `/p/{profile}/v1/runs`, consume events, translate to domain events (`translate.ts`), capability probe.
- Files: `apps/server/src/hermes/live/{gateway,translate,capabilities}.ts`
- Done when: tests with recorded fixtures from L2 pass; unknown events are counted, not crashed on.
- Test: `pnpm --filter @score/server test -- live/gateway`

**1.12 Live tests L1–L5 (with your OK)** · Lead + you
- Goal: run the SPIKE live tests and capture fixtures.
- Files: `docs/SPIKE.md` (results), `apps/server/test/fixtures/**`
- Done when: each test has a recorded outcome; ARCHITECTURE risks updated.
- Test: n/a (manual, commands recorded)

**1.13 Bridge plugin v0** · Lead · *adversarial review before merge*
- Goal: Python Hermes plugin: hooks → batched `POST /bridge/v1/events`; long-poll decisions → `resolve_gateway_approval`; fail-open (never blocks the agent).
- Files: `hermes-plugin/score_bridge/{plugin.yaml,__init__.py,client.py}`, `hermes-plugin/tests/*`, `hermes-plugin/pyproject.toml`
- Done when: pytest covers batching, Score-down behavior (drops, no exceptions), decision apply; manual install doc in SETUP.md.
- Test: `cd hermes-plugin && uv run pytest`

**1.14 Bridge ingest + approvals ledger** · Lead
- Goal: `/bridge/v1/*`, `approvals` table, `/api/approvals*`, events; three origins resolved idempotently.
- Files: `apps/server/src/http/{bridge,approvals}.ts`, `apps/server/src/domain/approvals.ts`, migration `0002_approvals.sql`
- Done when: tests cover double-decision (409), Telegram-answered-first, expiry; fake adapter produces approvals.
- Test: `pnpm --filter @score/server test -- approvals`

**Phase 1 gate** · Gemini whole-repo review + `/codex:review --base main`

## Phase 2: Chat, Tasks, Team, Settings

**2.1 Rooms + messages store/API** · Lead: migrations `0003_rooms.sql`; `/api/rooms*`; tests. Done when §5 room endpoints pass contract tests.
**2.2 Mention + slash parser** · Codex: `apps/server/src/domain/parse.ts` (pure). Done when table-driven tests cover all §5 command syntaxes and edge cases (emails, code spans, unknown agents).
**2.3 Routing engine** · Lead: unaddressed → lead; @mention → run; reply mentions → hand-off; hop limit + ping-pong guard. Done when fake-adapter tests show bounded hand-offs.
**2.4 Message streaming** · Lead: `message.delta` from run deltas; completion; tools summary part. Done when e2e shows streaming text.
**2.5 Chat UI: rooms list + thread** · Lead: `apps/web/src/routes/chat/*`. Done when it matches `chat.png` layout with fake data; keyboard navigable.
**2.6 Composer** · Lead: To chips, @autocomplete, slash menu (`GET /api/commands`), Plan first toggle, attach. Done when e2e sends a message and a `/assign`.
**2.7 Inline approval card + plan card** · Lead. Done when approve/deny from Chat resolves the ledger item and updates the Now card live (e2e).
**2.8 Chat side panels** · Codex: Files in play, Learned here, Also reachable on (pure presentational from `GET /api/rooms/:id`). Done when component tests pass.
**2.9 Tasks API** · Lead: status → column mapping, detail, actions via `hermes kanban` CLI (execFile, arg arrays). Done when tests with a stubbed CLI cover every action.
**2.10 Steps model** · Lead: parse/write `- [ ]` checklist in task body. Done when round-trip tests preserve the rest of the body.
**2.11 Tasks board UI** · Lead: columns, filter chips, card variants. Done when it matches `tasks.png`.
**2.12 Task drawer** · Lead: details, steps, activity, approval CTA, "See it in Flow". Done when e2e approves from the drawer.
**2.13 Profiles reader** · Lead: agents list/detail from profile dirs + `hermes profile show`. Done when fixture profiles produce `AgentDetail`.
**2.14 Team overview UI** · Lead: header band, tabs, overview cards. Done when it matches `team.png`.
**2.15 SOUL/AGENTS editor** · Lead: get, preview diff, put with etag. Done when a conflicting edit returns 409 and the UI shows the diff.
**2.16 Model, skills, memory, tools** · Lead (+ Codex for the skills-hub search list component). Done when each tab reads and edits through the adapter.
**2.17 Routines** · Lead: cron jobs via `/api/jobs` or `hermes cron`. Done when create/pause/run-now work against fake + stubbed live.
**2.18 Permissions + team rules** · Lead · *adversarial review*: map Go ahead / Ask me / Never to Hermes approval config; per-agent stricter-only. Done when tests reject loosening.
**2.19 Settings: providers + connections** · Lead. Done when status renders without ever reading secrets (test asserts no access to `.env`/`auth.json`).
**2.20 Settings: advanced config** · Codex: config search index + diff preview UI. Done when search finds keys by name and comment; apply requires a matching diff hash.
**Phase 2 gate** · Gemini + `/codex:review --base main`

## Phase 3: Score, Flow, Reports

**3.1 Lanes + hand-offs builder** · Lead: server computes `LaneBlock[]`/`Handoff[]` from tasks, runs, Score runs and events. Done when fixture timelines produce the blocks shown in `now-score.png`.
**3.2 Score timeline UI** · Lead: time axis, lanes, blocks, connectors, now line, hatched future, legend. Done when visual e2e snapshot matches with fake data.
**3.3 Now page cards** · Lead: headline, thread, "X is asking", Made today, composer, Pause everyone. Done when e2e covers approve-from-Now.
**3.4 Briefs model** · Lead · *adversarial review*: what a brief is (room message → plan → tasks); `/api/briefs*`. Done when a fake scenario yields one brief with nodes and edges.
**3.5 Flow auto-layout** · Codex: pure layered layout (seed: Studio's Kahn layering, MIT, attributed) with edge routing for back-edges ("sent back"). Done when property tests show no overlaps for ≤50 nodes.
**3.6 Flow canvas** · Lead: SVG nodes and edges, pan/zoom, fit-to-screen, scrollable area, zoom % control. Done when e2e zooms and fits; keyboard focus moves across nodes.
**3.7 Flow inspector + live log + stats** · Lead. Done when it matches `now-flow.png` with fake data.
**3.8 Reports aggregations** · Lead: tasks finished, runs, first-pass rate (review without `request-changes`), median time, spend (`state.db` cost columns), approvals. Done when fixture DB tests produce known numbers.
**3.9 Stacked bar chart** · Codex: `TasksByDayChart` (SVG, per-agent color + pattern for accessibility). Done when component tests pass.
**3.10 Time-split bars + tables + approvals card** · Lead. Done when it matches `reports.png`.
**3.11 CSV export** · Codex. Done when the CSV columns match the on-screen table.
**Phase 3 gate** · Gemini + `/codex:review --base main`

## Phase 4: Watch

**4.1 Frame capture** · Lead: translate bridge `pre/post_tool_call` into `WatchFrame`s (terminal, editor diff, browser). Done when fixture hooks produce frames; size caps enforced.
**4.2 Diff builder** · Codex: unified diff from patch/write tool args (pure). Done when table tests pass.
**4.3 Media store** · Lead: `/api/media/:id`, quota, cleanup. Done when quota tests pass.
**4.4 Watch UI panes** · Lead: terminal, editor, browser panes; "you're watching" banner; approval bar. Done when it matches `watch.png` with fake data.
**4.5 Scrub timeline** · Lead: markers by kind, drag to replay, "Live" snap. Done when e2e scrubs back and returns to live.
**4.6 What she's doing + Other screens** · Codex (presentational). Done when component tests pass.
**Phase 4 gate** · Gemini + `/codex:review --base main`

## Phase 5: Hardening
Packaging (`pnpm build && pnpm start`), a11y audit, perf (1k events/min), Hermes-upgrade drill (re-run fixtures against the newest Hermes), docs.

---

## First five tasks
1. **1.1** Contract package (shared types + stream envelope)
2. **1.2** Server skeleton
3. **1.3** score.db + migrations
4. **1.4** Event hub + `/api/stream` (with adversarial review)
5. **1.5** HermesPort + fake adapter

These need nothing from your live Hermes install, so they can start while the live tests (1.12) wait for your OK.
