# Score plan

Every task is ≤ half a day. **Operating model (owner decision, 2026-10-06):** Codex CLI (`gpt-6.1-sol`, high)
implements every task; Claude writes the brief, reviews every diff, integrates and commits (see CLAUDE.md
"Task loop"). The owner label on each task now means:
- **Lead**: integration-heavy or design-sensitive. Claude writes a detailed brief and reviews line by line;
  Claude may take it over if Codex fails twice.
- **Codex**: isolated and well-specified. Standard brief and review.
- **Gemini**: whole-repo review, run manually by you at phase gates.

Rules for every task: Claude reviews the diff and runs `pnpm check` before merging. Before merging a phase, run
a fresh Codex code review at `max` against `main` and the phase-gate Gemini review. Rejected review findings are noted in the task log
(`docs/TASKLOG.md`) with the reason.

Test commands: `pnpm test` (Vitest, all packages), `pnpm typecheck`, `pnpm lint`, `pnpm e2e` (Playwright vs.
fake adapter), `pnpm check` (= lint + typecheck + test + license), `uv run pytest` (in `hermes-plugin/`).

---

## Phase 0: Setup and plan ✅ (this phase)
Toolchain, reference study, spike, architecture, contract, plan, AGENTS.md / CLAUDE.md, empty scaffold.
Open items: Codex plugin enablement, the architecture adversarial review, and live tests L1–L5 (all need you).

## Phase 1: Foundation
**Plan approved by the owner on 2026-10-06.**
Revised after the architecture review (ARCHITECTURE v0.2). Section refs like D1 point to ARCHITECTURE.md.

**1.1 Contract package** · Lead
- Goal: zod schemas + inferred types for API-CONTRACT §1 (shared types), §2 (stream envelope, control frames, event union) and §11 (bridge protocol).
- Files: `packages/contract/src/{types,stream,bridge,index}.ts`, `packages/contract/test/*.test.ts`
- Done when: every type in §1, §2 and §11 has a schema; round-trip tests pass for one fixture per type; control frames are a separate union from durable events.
- Test: `pnpm --filter @score/contract test`

**1.2 Server skeleton + session pairing** · Lead
- Goal: Fastify app factory, config (`SCORE_HOME`, port, mode), error shape, CSRF guard, `GET /api/system` (fake), pairing (`/api/session*`, one-time token printed to the server terminal, hashed at rest), and an **H** route guard (D7.1).
- Files: `apps/server/src/{app,config,errors}.ts`, `apps/server/src/http/{system,session}.ts`, `apps/server/src/auth/*`, tests
- Done when: `inject()` tests cover the error shape, a 403 without `X-Score-Client`, a 401 `not_paired` on an H route, a successful pairing, token reuse rejected, and the cookie flags.
- Test: `pnpm --filter @score/server test`

**1.3 score.db + migrations** · Lead
- Goal: `node:sqlite` wrapper (WAL, busy timeout), forward-only migrations, infrastructure tables (`events` with `epoch`, `ingest_keys`, `ingest_checkpoints`, `gaps`, `command_intents`).
- Files: `apps/server/src/db/*`, `apps/server/migrations/0001_infra.sql`
- Done when: fresh DB migrates; re-run is a no-op; the epoch is created once; tests use temp dirs.
- Test: `pnpm --filter @score/server test -- db`

**1.4a Ingest path** · Lead · *adversarial review before merge*
- Goal: single-writer ingest queue; each observation applies dedupe + projection updates + event append + checkpoint in **one transaction**; terminal-state guards (D1, D2.3).
- Files: `apps/server/src/hub/{ingest,projections}.ts`, tests
- Done when: tests prove duplicates are dropped by ingest key; out-of-order delayed observations can't regress terminal states; a crash mid-transaction leaves neither the event nor the projection; snapshot reads return projection + `asOfSeq` from one read transaction.
- Test: `pnpm --filter @score/server test -- hub/ingest`

**1.4b `/api/stream` with subscription fence** · Lead
- Goal: SSE endpoint: register-buffer → head H → replay `(since,H]` → release; control frames without IDs; epoch/retention/future-cursor resets; byte budget + write timeout; retention prune (D1).
- Files: `apps/server/src/hub/{sse,fanout}.ts`, `apps/server/src/http/stream.ts`, tests
- Done when: a concurrency test with producers writing during replay shows no gap and no duplicate; slow-client disconnect doesn't block others; each reset reason is covered.
- Test: `pnpm --filter @score/server test -- hub/sse`

**1.4c Ingest-key retirement** · Codex (added after the 1.4a review)
- Goal: keep `ingest_keys` from growing forever without re-enabling duplicates. Per source, retire keys strictly below a durable acknowledged floor: the checkpoint position for monotonic sources; for bridge producers, the incarnation's acked counter after the producer is gone for longer than the spool lifetime. Keep a per-source floor row so anything at or below the floor is still rejected as a duplicate.
- Files: `apps/server/src/hub/retire.ts`, migration if a floor table is needed, tests
- Done when: after retirement, redelivery at or below the floor is still rejected; keys above the floor are untouched; retirement runs in bounded batches.
- Test: `pnpm --filter @score/server test -- retire`

**1.5 HermesPort + fake adapter** · Lead
- Goal: adapter interface (domain calls + observations into the ingest path) and a scripted fake with the four neutral agents, including approvals of all three origins and a gap interval.
- Files: `apps/server/src/hermes/{port,index}.ts`, `apps/server/src/hermes/fake/*`, boundary lint rule + boundary test
- Done when: `SCORE_MODE=fake pnpm dev` streams the scenario; the boundary test fails if non-adapter code mentions Hermes paths, URLs or event names.
- Test: `pnpm --filter @score/server test -- fake boundary`

**1.6 Web shell** · Lead
- Goal: tokens (CSS vars), @fontsource fonts, top nav (6 destinations + "Now" dot), route stubs, ⌘K stub, avatar.
- Files: `apps/web/src/{main,App}.tsx`, `apps/web/src/styles/tokens.css`, `apps/web/src/shell/*`
- Done when: each route renders its title; no network requests to font CDNs (asserted in e2e); matches the nav in `docs/design/*.png`.
- Token source: `docs/design/html/*.html` inline styles. Most-used values: ink #12131A, muted #5E626C / #6E727C, hairline #DFE2E8, ground #ECEEF2, subtle #F4F5F8; agent tints #ECE8FF / #DDF6EE / #FFF1D1 / #FFE3E9 with text #4A2FD9 / #00694F / #8A5A00; radii 999px (pills), 28px (cards), 20/16/14/8px.
- Test: `pnpm --filter @score/web test && pnpm e2e -- shell`

**1.7 `useStream` with per-query resync** · Lead
- Goal: one EventSource per tab; per-query `asOfSeq`; buffer during refetch; apply `seq > asOfSeq`; drop superseded fetches; handle `stream.hello` epoch and `stream.reset` (D1, contract §2).
- Files: `apps/web/src/data/{stream,resync,queryClient}.ts`, tests with a mock EventSource and controllable fetches
- Done when: tests cover a delta arriving during refetch (not lost, not double-applied), a stale fetch resolving last (ignored), an epoch change → full resync, and unknown event types ignored and logged.
- Test: `pnpm --filter @score/web test -- stream`

**1.8 AgentGlyph component** · Codex
- Goal: render an agent as color + shape (8 shapes), sizes S/M/L, accessible name, high-contrast outline mode.
- Files: `apps/web/src/components/AgentGlyph.tsx` + test
- Done when: a snapshot per shape; `aria-label` includes the agent name; the shape is distinguishable in a grayscale test.
- Test: `pnpm --filter @score/web test -- AgentGlyph`

**1.9a SQLite readers + checkpoints** · Lead
- Goal: read-only readers for `kanban.db` and per-profile `state.db`; tail `task_events.id` and `messages.id` per DB incarnation; never timestamps (D2.4).
- Files: `apps/server/src/hermes/live/{sqlite,kanban,sessions}.ts`, fixture DBs built from `docs/spike/*-schema.sql`
- Done when: tests cover carried rows with older timestamps, same-millisecond rows, DB replacement (incarnation change → re-baseline), and `mode=ro` opening.
- Test: `pnpm --filter @score/server test -- live/sqlite`

**1.9b Session reconciliation** · Codex
- Goal: reconcile recently active sessions by `message_uid`/`tool_call_uid` (edits, `active`/`compacted` flips, rewind, compaction) into ingest observations.
- Files: `apps/server/src/hermes/live/reconcile.ts` + fixtures
- Done when: fixtures for rewind, compaction and edit produce the expected observations with no duplicates on re-run.
- Test: `pnpm --filter @score/server test -- reconcile`

**1.10 Upstream SSE client** · Codex
- Goal: robust SSE parser/client (multi-line `data:`, comments, `id:`, retry, `Last-Event-ID` resume, abort, `replay.truncated` surfaced).
- Files: `apps/server/src/hermes/live/sse-client.ts` + tests
- Done when: WHATWG event-stream parsing cases pass; resume test against a local server; truncation produces a typed signal.
- Test: `pnpm --filter @score/server test -- sse-client`

**1.11a Gateway runs** · Lead
- Goal: start/stop/steer via `/p/{profile}/v1/runs` with `Idempotency-Key` = `score_turn_id` through `command_intents`; status polling; truncation/restart → gap interval + reconciliation; credential generations (D2.5, D2.4).
- Files: `apps/server/src/hermes/live/{gateway,translate,intents}.ts`, `apps/server/src/hermes/live/credentials.ts`
- Done when: recorded-fixture tests (L2/L3/L4) pass; a crash after admission reconciles via idempotency without a double run; an unknown event is counted, not fatal.
- Test: `pnpm --filter @score/server test -- live/gateway`

- Note from 1.9b (applies to the task that wires session reconciliation into ingest, Phase 2): reconciliation
  revisions can repeat (rewind then undo: A→B→A), so they must not be used directly as ingest identities. That task
  compares each revision with the projection's stored revision, emits an observation only on
  change, and builds the identity with a per-message version counter (`message:<…>:<logicalId>@v<n>:<revision>`).

**1.11b Compatibility fingerprint gate** · Codex
- Goal: compute the fingerprint (D2.2), compare against `tested-fingerprints.json`, expose `SystemStatus.compatibility`, disable features with `feature_disabled`.
- Files: `apps/server/src/hermes/live/fingerprint.ts`, `apps/server/src/hermes/tested-fingerprints.json`
- Done when: tests cover tested, unknown and partial (bridge private API missing) fingerprints.
- Test: `pnpm --filter @score/server test -- fingerprint`

**1.12 Live tests L1–L5** · ✅ done 2026-10-06 (SPIKE.md). Remaining: convert `docs/spike/*.json` into server fixtures (part of 1.9a/1.11a).

**1.13a Bridge plugin: handshake, events, redaction, spool** · Lead · *adversarial review before merge*
- Goal: Python plugin with `hermes_private.py` (all private calls), `hello` handshake (isolation mode, private API availability), hooks → batched events with `(incarnation, counter)`, mandatory `redact_sensitive_text(force=True)` before truncation, bounded on-disk spool, fail-open (D2.1, D2.4, D6).
- Files: `hermes-plugin/score_bridge/{plugin.yaml,__init__.py,client.py,spool.py,redact.py,hermes_private.py}`, `hermes-plugin/tests/*`, `hermes-plugin/pyproject.toml`
- Done when: pytest covers batching, Score down (spool, then drain, drop counter), secret fixtures redacted in every hook payload, host-isolation mode reported; manual install steps are in SETUP.md.
- Test: `cd hermes-plugin && uv run pytest`

**1.13b Bridge: gateway approvals with exact targets** · Lead · *adversarial review before merge*
- Goal: report `requestId` only when provably exact (D4.2); poll leased decisions and resolve by exact id only; never `register_gateway_settle` (D4.4); live check. Gate ids and the ledger come from 1.14b.
- Files: `hermes-plugin/score_bridge/approvals.py`, `apps/server/src/hermes/bridge.ts`, tests
- Done when: tests show no FIFO path exists; a missing id → non-actionable; delivery only to the reporting producer; a live check on scoretesta (manual mode) resolves the exact request.
- Test: `cd hermes-plugin && uv run pytest && pnpm --filter @score/server test -- bridge`

**1.13c Bridge: Kanban denials, view-only (rescoped 2026-10-07, owner decision)** · Lead
- Goal: verified unattended-denial detection in the plugin; view-only "Needs you" cards linked to the task; a `hermes`
  CLI runner; `POST /api/tasks/:taskId/actions` for `comment` (Deny) and `unblock` (with a note) (D4.3). No grants.
- Done when: positive/negative denial detection tests; a card per (task, run, digest), closed when the task leaves
  `blocked`; the two actions run the CLI with exact argument arrays and map rejections to 409; a live check on
  scoretesta (a blocked worker appears in Score; Deny comments; Unblock re-dispatches).
- Test: `cd hermes-plugin && uv run pytest && pnpm --filter @score/server test`

**Order change (2026-10-07):** 1.13b and 1.13c need the server side of the bridge, so the next step is 1.14a, then
1.14b, then 1.13b, then 1.13c.

**1.14a Bridge server: handshake, producer tokens, event ingest** · Lead
- Goal: `~/.score/bridge.token` bootstrap; `/bridge/v1/hello` (producer registry, hashed short-lived producer tokens,
  enabled features); `/bridge/v1/events` → ingest observations with D2.3 identities, gap handling, `ackedThrough`;
  bridge tool calls into a session-keyed projection plus `log.line`; approval-hook signals kept for 1.14b;
  `SystemStatus.bridge`.
- Files: `apps/server/src/hermes/bridge/*`, migration `0004_bridge.sql`, `src/http` wiring, tests
- Done when: contract §11 request/response tests; auth scoping (a bootstrap token can't post events; a producer token
  can't call /api); dedupe on redelivery; gap → `gap.recorded`; the Python plugin talks to a real server (lead check).
- Test: `pnpm --filter @score/server test -- bridge`

**1.14b Approvals ledger + delivery outbox** · Lead (was 1.14)
- Goal (design: docs/briefs/1.14b.md after two design reviews): gate-id correlation in the plugin; operations with phases; `approval_deliveries` outbox (`intent → delivering → applied | not_pending | failed | unknown`); attribution only on confirmed delivery; `/api/approvals*` (H); origin dedupe (D4).
- Files: `apps/server/src/domain/approvals.ts`, `apps/server/src/http/approvals.ts`, migration
- Done when: tests cover a double decision (409), an answer from another surface first (`not_pending` → "answered elsewhere", never deny), a Score crash between intent and apply, guardian escalation linking, and a non-actionable card rejecting decisions.
- Test: `pnpm --filter @score/server test -- approvals`

**Phase 1 gate** · Codex code review at `max` against `main` + Gemini whole-repo review (you)
  **Done 2026-10-08:** Codex gate review (fail → 13 + 3 findings fixed, merged); Gemini review **skipped by the owner**.

## Phase 2: Chat, Tasks, Team, Settings

**Execution (owner, 2026-10-08):** independent tasks run in parallel, each in its own worktree with its own Codex CLI
session (gpt-6.1-sol, high). The lead assigns migration numbers up front, reviews and merges one at a time, and
resolves integration conflicts. Migrations from Phase 1 end at `0007`; numbers below are reassigned per brief.

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
**Phase 2 gate** · Gemini + `/codex:review --base main` — **done 2026-10-08**: lead review (Codex out of credits; owner: "do it yourself"), pass after 6 fixes
(`docs/reviews/2026-10-08-phase2-gate-lead.md`); Gemini not run (owner's call).

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
**3.12 Profile management** · Codex · *adversarial review* (owner request, 2026-10-08): create (blank or cloned) / rename /
describe / delete agents from Team via `hermes profile …`; a new agent is ready for Score (per-profile API key, bridge
plugin, gateway); delete needs the typed name and keeps an export first. Done when create → drive → delete works on test
profiles and every Hermes write is an exact, tested CLI call.
**3.13 Remote access mode** · Codex · *adversarial review* (owner request, 2026-10-08: "allow private network and plain LAN
address"): opt-in listen address (Tailscale/WireGuard interface or LAN), pairing required for every request and the stream,
Host/Origin allowlist (DNS rebinding), optional TLS with the owner's certificate, a clear warning when serving plain HTTP
beyond loopback. Done when an unpaired LAN client gets nothing but the pairing page and loopback behaviour is unchanged.
**3.14 Visual QA pass** · Lead audit → Codex fixes (owner: "button and arrow alignment are off"): every screen against
its design HTML at 1440, 1024 and 390 px; fix alignment of buttons, arrows, icons and baselines. Done when the audit list is
empty and screenshot e2e covers each destination.
**Phase 3 gate** · Gemini + `/codex:review --base main` — **done 2026-10-08**: lead review per the owner ("review the code yourself"), pass
(`docs/reviews/2026-10-08-phase3-gate-lead.md`).

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

**5.1 Packaging** · `pnpm build && pnpm start` serves the built app and API from one loopback port, a `score` launcher
script, a systemd user unit example, upgrade-safe data in `$SCORE_HOME`. Done when a fresh clone builds, starts and passes
a smoke e2e against the built app.
**5.2 Accessibility audit** · Lead audit (keyboard, focus, names, contrast, reduced motion) → fixes. Done when the audit
list is empty.
**5.3 Performance** · 1k events/min sustained through ingest → SSE → web; budgets for ingest latency, stream lag, page
render, DB growth. Done when a repeatable load test meets the budgets.
**5.4 Hermes upgrade drill** · Re-run recorded fixtures and the fingerprint against the newest Hermes; record breakages.
**5.5 Docs** · README user guide (install, demo, live setup, remote access, agents, troubleshooting).
**5.6 Verify a new Hermes version** · After a Hermes update, Settings says approvals in Score are paused until the new
build is checked, and offers "Check this Hermes version": print the fingerprint, compare schemas, capabilities, hooks and
pattern keys with the tested version, and record the build (union of pattern keys and config keys) only when they match;
otherwise show what changed. Done when an update with unchanged internals is re-enabled by one confirmed click and a
changed one stays off with a clear report.
**5.7 Stream batching** · Apply stream events in the browser once per animation frame (per query), so bursts don't block
the main thread. Done when the load test's browser budgets pass at 1,000 events/min on an idle machine.
**5.8 Agent Channels and History tabs** · Channels: the messaging platforms this agent is reachable on (gateway state),
with connect commands; History: the agent's past runs (outcome, duration, cost, task/brief links, Watch replay). Done when
both tabs match team.png's tab style with fake data and live adapters read only.
**5.9 Plugins and look + New task** · Settings › Plugins and look: Hermes plugins per profile (list, enable/disable via the
CLI) and Score's theme (light, dark, system); Tasks › New task dialog on the existing create path. Done when each works in
fake mode with tests and e2e.
**5.10 Sign in from the browser** · Settings › Models and keys: device-code providers sign in with a link and code shown in
Score (status followed until connected), key-based providers take a pasted API key (stdin to `hermes auth add`; never stored,
logged or echoed; plain-HTTP remote needs an explicit acknowledgement). The terminal command stays as the fallback
(ARCHITECTURE D2.7). Done when both work in fake mode with tests and e2e, and live on `scoretesta` (a device sign-in started
and cancelled; a dummy key added and removed).
**5.11 Model picker** · `GET /api/models` from Hermes's model options (connected providers only); a searchable picker in Add
agent and the agent's Model tab; picking sets model and provider. Done when typing "gpt" lists matching models from each
connected provider with availability and price, and a created agent has both set (fake + tests + e2e).
**5.12 Attachments to agents** · Image attachments in Chat reach the addressed agents' runs as image parts (Hermes
`/v1/runs` list input; ≤ 6 MB raw per message, a note for what didn't fit). Done when tests and a fake e2e show it.
**5.13 Pause covers new tasks** · Children linked to a paused brief, tasks assigned to a paused agent, and tasks created
while the team is paused are held too (parked on arrival, released with the pause). Done when each path has a test.
**5.14 Plan start survives a restart** · Plan start is a durable operation (steps recorded before the CLI calls); startup
finishes or reports it. Done when a crash between steps is recovered in a test.
**5.15 Spend per day** · Score snapshots each Hermes session's cumulative cost so Reports can split a session's spend
across days (cost deltas per window); history before the first snapshot stays unknown. Done when a session crossing
midnight is split correctly in tests.
**5.16 Recover expired runs' results** · When Hermes no longer knows a run, Score reads the session's final answer from
Hermes's own records (read-only) and completes the reply, else marks it interrupted. Done when both paths are tested.
**5.17a Kanban attempts as runs (read-only projection; v3 splits it into 5.17a-1 Kanban DB only and 5.17a-2 bridge provenance)** · Kanban worker attempts become runs in Flow, Now and Reports with
exact provenance (design v3 pending; see docs/briefs/5.17.md). Done when fixtures cover synthetic rows, restore/rollback,
A→B→A revisions, pruned claims, short gaps, unknown states, host isolation and requested changes.
**5.17b Kanban Stop** · Needs an upstream Hermes operation (docs/proposals/hermes-attempt-fenced-stop.md, to be extended
with durable intent and fenced launch registration). Until then Score says Stop is unavailable for Kanban attempts.

**5.18 HTTPS-only remote access** · Owner 2026-10-09: remote mode serves the app only over HTTPS; plain HTTP gets an
HTTPS setup guide (`/setup/https`), the API answers 426. `scripts/score tls` makes a local CA + server cert. Done when the
brief's tests pass (docs/briefs/5.18.md) and the live LAN deployment runs on HTTPS.

**5.19 Owner feedback round 1** · Model saves fast with clear feedback; config reads cached by file signature; Model tab
shows the current model; Settings model edit fixed; plugins move to each agent's page; Advanced collapsible
(docs/briefs/5.19.md).

**5.20 Owner feedback round 2** · Messaging setup from the browser (tokens via `hermes config set`), delete messages
(Score-side, with Undo), a task-first Now (chat replies as a band, close blocks grouped) (docs/briefs/5.20.md).

**5.21 Reports: instant ranges and a custom range** · Reports stops waiting on Hermes CLI reads (agent ids from Score's DB),
loading state + prefetch, `range=custom&from&to` (docs/briefs/5.21.md).

**5.22 Tailscale certificates** · Owner 2026-10-09: devices connect through Tailscale with a real (Let's Encrypt) certificate
for the ts.net name, while the LAN address keeps Score's own certificate; Score picks by SNI, renews daily, reloads
without a restart (`scripts/score tailscale`, `SCORE_TLS_NAMES_DIR`). Done by the lead.

**5.23 Responsiveness and save feedback** · Owner 2026-10-09: pages answer from Score's agent projection with a
background Hermes refresh (live mode); the first read after an agent-affecting write is fresh; `config set K` keeps cached
answers for unrelated keys; Advanced search never shows non-matching settings while loading; security password: Check
button (`POST /api/session/security/check`) and a confirmation when set. Done by the lead. HTTP/2 deferred (stream code
uses HTTP/1 response internals).

**5.24 Chat message actions** · Actions under each message (no overlap with the timestamp): own messages Edit (edit and
resend; original marked edited), Copy, Delete; agent replies Copy, Retry, Delete (docs/briefs/5.24.md).

**5.25 Chat (learned from hermes-webui, owner 2026-10-09)** · Agent replies render as Markdown (react-markdown + GFM,
sanitised; code blocks with syntax highlighting and a Copy button; Mermaid diagrams); a Stop button in the composer for a
reply in progress; tool-call cards (name, arguments, result snippet, expand/collapse all) and collapsible thinking cards;
a context meter (tokens, cost, fill) with `/compress`, `/model`, `/usage`; Hermes `clarify` questions answered with
inline buttons; voice input (Web Speech API). After 5.24 (same files).
**5.26 Conversations** · Rooms: pin, archive, projects (named, coloured groups), `#tags`, search message content;
export a room as Markdown or JSON; read-only share link (sanitised snapshot, revocable, owner-confirmed); bring in
sessions started outside Score (CLI, Telegram…) and continue them in a room.
**5.27 Workspace and agents** · Workspace: rendered Markdown preview, syntax highlighting (CodeMirror), git branch and
changed-files badge, `workspace://` links in chat that open the file, resizable panel; a live todo panel from the
agent's todo tool.
**5.28 Phone** · Installable app (PWA: manifest, service worker, offline shell), notifications for approvals, finished
routines and agent errors (Notification API over HTTPS); passkeys (WebAuthn) as an alternative to pairing links;
phone-friendly Enter (newline on touch) and a send-key setting.

**5.29 Small wins** (owner 2026-10-09, ideas from the owner's description of ekko-studio; no code or docs read) · QR code
for "Pair another device"; a log viewer (Score's log, filter by level and keyword, redacted); Reports: cache hit rate,
currency toggle, 30-day trend chart.
**5.30 Documents** (docs/briefs/5.30.md) · Attach and preview documents (drag, drop or paste PDF, DOCX, XLSX, CSV, HTML, text, images), inline
previews in chat and workspace, attach workspace files to a message.
**5.31 Model settings** (docs/briefs/5.31.md) · Fallback chains, aliases, hide unused models, speech-to-text and text-to-speech model settings
(per agent, through Hermes).
**5.32 Profile import** (docs/briefs/5.32.md) · Restore an agent from an exported bundle (export exists), with a preview of what it contains.

**5.33 Rewind a conversation** · Owner 2026-10-09: editing or deleting your message hides it and everything after it as a
previous version (switcher to view), and rewinds each agent's Hermes session to before it through the bridge plugin
(Hermes's own session rewind, as /undo). Refuses while agents are answering; memory is not rewound (docs/briefs/5.33.md).

**5.38 Writing pass** · (owner 2026-10-11) One writing guide (docs/WRITING.md) applied to every string, server error and agent tool text. Done.

**5.39 Live feel** · (owner 2026-10-11, inspired by an "agent loop" explainer video) A live status line on working agents,
a soft glow on the active step, counters that tick up live, approvals that turn into a green check in place, a short
summary when a run ends; in the workflow editor, the live state of a running run on the canvas and a **Preview** that
plays the drawn workflow with no agents and no tokens (docs/briefs/5.39-live-feel.md).

---

## First five tasks
1. **1.1** Contract package
2. **1.2** Server skeleton + session pairing
3. **1.3** score.db + migrations
4. **1.4a** Ingest path (adversarial review before merge)
5. **1.4b** `/api/stream` with subscription fence

None of them need the live Hermes install.

## Phase 6: Workspace and Knowledge (owner request 2026-10-09; design docs/briefs/6.0-workspace-knowledge.md)
**6.1 Workspace** · Team › agent › Workspace: browse, preview, edit the agent's `terminal.cwd`; set the folder. Path safety
and blocked list per the design. Done when the design's tests pass on the fake adapter and a live check on a test profile.
**6.2 Knowledge server** · `~/score-vault` (git), index + FTS5 (migration), notes/search/backlinks/history API, stream event.
**6.3 Knowledge web** · Knowledge destination: editor, preview, wikilinks, backlinks, history, search.
**6.4 Agent knowledge tools** · score_bridge tools (search/read/list/write/append) over the bridge, attributed, limited.

## Phase 7: larger features (owner 2026-10-09; each needs a design + security review before building)
**7.1 Workflow builder** · Reusable multi-agent pipelines on a canvas extending Flow: nodes per agent/runtime, branches,
human approval gates, budgets and deadlines, pause/resume/stop, replay, JSON export/import.
**7.2 Coding agents as team members** · Claude Code, Codex, OpenCode as room participants next to Hermes agents.
**7.3 Web terminal** · A terminal on the server in the browser (paired, HTTPS only; security design first).
**7.5 Orchestrator** · (owner 2026-10-10, before 7.1) A lead agent runs a goal as an agentic workflow through Score tools (hand a step to an agent, wait for its result, ask the person at a gate, check budget, report); Score validates every request against limits, budgets, gates and permissions. Design + security review first.
**7.7 Coding agents as orchestration and workflow workers** · (owner 2026-10-11) Claude Code, Codex and Antigravity take
steps handed out by a Hermes lead or drawn in a workflow; design and adversarial review first (orchestrator journal,
stop, recovery and spend semantics for coding runs). Until then orchestrations and workflows refuse coding agents.
**7.4 Backlog** · Long rooms auto-summarise at a token threshold; pop-out window per agent; journey graph (tasks,
memories, skills over time); Score as an MCP tool server for its agents.
**6.5 Knowledge editor** · (owner 2026-10-10) Obsidian-style live preview in CodeMirror (Markdown rendered inline except the edited line; files stay byte-exact), notes open rendered by default, split view on wide screens, styled tables/code/quotes/task lists/callouts.
Not planned (owner): full-screen voice stage; multiple user accounts with roles.


## Phase 8: reading and living with it (owner 2026-10-16)
**8.1 CLI quota meters** · Team › coding agent (and the agent picker) shows each CLI's own quota as meters: Antigravity
from its `/usage` answer (per model group, 5-hour and weekly, resets in the owner's timezone); Claude Code from the
`rate_limit_event` every turn already sends (5-hour and 7-day utilisation and resets, "as of the last turn"); Codex from
the `rate_limits` line in Codex's own session log of runs Score started (located by the run's thread id, read-only,
never other Codex files; unknown if the format changes). No extra CLI calls.
**8.2 Memory notes from compaction** · When a Hermes session is compacted (5.36), Score saves the summary as a Knowledge
note `Memory/<agent>/<YYYY>/<MM>/<YYYY-MM-DD> <room>.md` (frontmatter: date, agent, room, session, weight 1–5 default 3,
changeable in the note), never overwriting; a monthly index note per agent lists that month's notes, highest weight
first. Written through the vault (history, the 6.x write rules); agents can read them like any note.
**8.3 Theme packs** · Settings › Look offers built-in themes (3–4) that change colours, fonts, corner radius, spacing
density and a few layout variants (e.g. side navigation vs top navigation), switched live and remembered; a theme is a
small file of design tokens plus a layout choice; today's look stays the default theme. Design first.
**8.4 Chat-first user view** · (reference: a Grok-style chatbot app) a second interface for the same owner: a chat
window with a sidebar of rooms and conversations, a composer that can start an orchestration, and progress arriving as
chat messages; no Reports, Team or Settings. The current interface stays as the admin view; switch in the avatar menu,
optionally guarded by the security password. Single owner (multi-user accounts stay not planned). Design first.
