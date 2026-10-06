# Score architecture

Status: **DRAFT v0.1, pending `/codex:adversarial-review`** (see "Review log" at the end).
Inputs: `docs/SPIKE.md` (what Hermes v0.21 exposes) and `docs/REFERENCE-NOTES.md` (what Hermes Studio did).

## 1. Shape

Your default preference holds, with **one push-back**: we need a small amount of Python, but as a **Hermes
plugin** that runs inside Hermes's own processes, not as a separate sidecar service. Reason: the only way to see
*every* agent's tool calls and approvals live (including Telegram, cron and Kanban-worker runs) is Hermes's
in-process plugin hooks (SPIKE (a)3, (b)). Node cannot reach those. A sidecar would not help either, because it
would be a different process.

```
 Browser (apps/web, React SPA)
   │  REST  /api/*        (commands + snapshots, JSON, zod-validated)
   │  SSE   /api/stream   (ONE stream for every screen, resumable by Last-Event-ID)
   ▼
 Score server (apps/server, Node 24 + Fastify)               ~/.score/score.db  (Score-owned state)
   ├─ http/        routes = API-CONTRACT.md, nothing else
   ├─ hub/         event hub: persist → seq → fan-out; snapshot+delta
   ├─ domain/      rooms, mentions, approvals ledger, agents view, reports
   └─ hermes/      ◄── THE ADAPTER: the only code that knows Hermes exists
        ├─ gateway.ts    HTTP to API server: /p/{profile}/v1/runs, /events, /approval, /steer, /stop, /api/jobs
        ├─ kanban.ts     read kanban.db (read-only SQLite) · write via `hermes kanban …` CLI
        ├─ sessions.ts   read state.db (read-only SQLite): sessions, messages, usage, cost
        ├─ profiles.ts   read profile dirs (config.yaml, SOUL.md, AGENTS.md, skills, memory) · write via `hermes` CLI
        ├─ bridge.ts     ingest endpoint for the Score bridge plugin + approval decision queue
        ├─ translate.ts  every upstream event name/shape → Score domain events (one table, versioned)
        └─ fake/         scripted fake Hermes (same port), for dev, tests and e2e without tokens
   ▲                ▲                                 ▲
   │ HTTP+SSE       │ read-only SQLite + CLI          │ HTTP POST (events) / long-poll (decisions)
 Hermes gateway   ~/.hermes/{kanban,state}.db       Score bridge plugin (Python, hermes-plugin/score_bridge)
 (API server on)  ~/.hermes/profiles/*              loaded in gateway, Kanban workers, cron, CLI
```

Repo layout:

```
apps/web/            React 19 + Vite + TypeScript SPA
apps/server/         Fastify server + Hermes adapter
packages/contract/   zod schemas + TS types for every endpoint and event (generated from/checked against API-CONTRACT.md)
hermes-plugin/       score_bridge Python plugin + pytest (Phase 1b; needs uv, see SETUP.md)
e2e/                 Playwright tests (run against the fake adapter)
scripts/             license check, helpers
docs/
```

## 2. Key decisions

### D1. One live stream: SSE, not WebSocket
- Traffic is one-way (server → browser). Every command is a REST POST, which gets normal status codes,
  idempotency and validation.
- SSE gives automatic reconnect and `Last-Event-ID` for free, passes through the Vite dev proxy, and is easy
  to debug with `curl -N`.
- Envelope: `{ seq: number, ts: string, type: string, data: object }`. `seq` is a global, gap-free integer
  assigned when the event is persisted to `score.db` (`events` table), **before** fan-out (Studio's pattern).
- **Snapshot + delta**: every snapshot endpoint returns `asOfSeq`. The client opens the stream with
  `?since=<asOfSeq>`, so no event between snapshot and subscribe is lost or double-applied. On reconnect the
  browser resends `Last-Event-ID`. If that seq has been pruned, the server sends `stream.reset` and the client
  refetches snapshots.
- Retention: events are kept 7 days (configurable); Watch frames are kept separately (D6).
- Backpressure: per-client queue limit; a slow client is disconnected with `stream.reset` instead of blocking the hub.

### D2. The Hermes adapter boundary
- `apps/server/src/hermes/` is the **only** place that imports Hermes paths, URLs, CLI verbs or event names.
  Everything else talks to the `HermesPort` interface and receives Score domain events. Lint rule:
  `no-restricted-imports` blocks `hermes/*` internals outside `hermes/index.ts`.
- `HermesPort` has two implementations: `live` and `fake`. The fake one replays scripted scenarios
  (neutral example agents) so the whole UI and the e2e suite run with no Hermes and no model spend.
- **Version gate**: at startup the adapter reads `hermes --version` and `GET /v1/capabilities`, records
  them, and exposes `GET /api/system`. Unknown majors run in degraded, read-only mode with a banner.
  `translate.ts` is keyed by capability, so a Hermes upgrade touches one file plus its tests.
- **Per-profile wiring (verified live, SPIKE L3)**: every profile has its own `state.db`
  (`~/.hermes/profiles/<name>/state.db`; `default` uses `~/.hermes/state.db`) and its own `API_SERVER_KEY`.
  Score stores keys in `~/.score/hermes-keys/<profile>` (0600) and sets them with `hermes -p <profile> config set
  API_SERVER_KEY …` when an agent is added. `kanban.db` is shared. New profiles are served automatically.
- **Reads** use SQLite opened read-only via Node's built-in `node:sqlite`
  (`file:…?mode=ro`, WAL-safe, no native addon). The reader tails `task_events` / `messages` by composite
  cursor `(created_at, id)`, never by timestamp alone.
- **Writes** never touch Hermes's SQLite. They go through `hermes` CLI subcommands (kanban, profile, config) or
  the gateway HTTP API. CLI calls use `execFile` with argument arrays (no shell), a timeout, and parsed output.

### D3. Starting agent work
| Intent | Mechanism | Live events | Approvals |
|---|---|---|---|
| Chat message to agent(s) in a room | `POST /p/{profile}/v1/runs` with `session_id = score:{room}:{agent}` and room transcript as `conversation_history` | run SSE | `approval.request` → `/approval` |
| `/assign`, New task, hand-offs that should be durable | `hermes kanban create/assign` | bridge plugin + `task_events` tail | none by default (see D4) |
| `/routine` | `hermes cron` / `/api/jobs` | bridge plugin | none (cron_mode) |
| Pause / stop | `/v1/runs/{id}/stop`; Kanban `block`; "Pause everyone" = stop Score-started runs + pause dispatch | — | — |

@mention routing (designed from scratch: the Graphite plugin isn't installed on this machine, so there is no code
to reuse): an unaddressed
message goes to the room's lead agent. `@agent` starts a run for that agent. When an agent's reply @mentions
another agent, that is a hand-off: Score starts the next run, up to a per-room hop limit (default 6) and with a
loop guard (the same pair cannot ping-pong more than 2 times without a human message).

### D4. Approvals reach the UI through one ledger
- Score keeps an `approvals` table: `{id, origin, agent, runId?, sessionKey?, taskId?, requestId?, command (redacted),
  description, choices, status, createdAt, resolvedAt, resolvedBy, choice}`. Every screen reads it (Now card, Chat
  inline card, Flow inspector, Watch bar, Tasks "Needs you", Reports).
- Sources:
  1. **Runs Score started**: the adapter consumes `approval.request` from the run SSE. Resolve with
     `POST /p/{profile}/v1/runs/{id}/approval`.
  2. **Gateway sessions** (Telegram etc.): the bridge plugin's `pre_approval_request` hook posts the request to
     Score. Resolve: the plugin long-polls Score for decisions and calls `resolve_gateway_approval(session_key,
     choice, request_id)` **in-process**. This is *additive*: Telegram still shows the prompt, and the first answer wins.
     Score marks the item resolved on `post_approval_response`.
     **Decided (owner, 2026-10-06): additive, alongside Telegram.** The exclusive plugin transport
     (`security.approval.transport`) is not used. *Verified live (SPIKE L4).* Resolution signal is the
     `post_approval_response` hook (in-process resolution emits no `approval.responded` on the run SSE).
     Correlation is by `session_key` + command, because the gateway-surface hook has `request_id: None`.
     Parallel tool calls in one session can make this ambiguous; in that case Score resolves the oldest
     pending item for that session and shows a warning.
     Smart-mode guardian decisions (`surface: smart`, `decided_by: aux_llm`) are recorded as resolved
     approvals with `resolvedBy: 'guardian'`, so Reports and the timeline show what was auto-approved.
  3. **Blocked Kanban workers** (origin `kanban`). Kanban workers and cron cannot ask a human: under
     `approvals.single_query_mode: deny` they deny instantly, without firing `pre_approval_request` (SPIKE L5).
     **Decided (owner, 2026-10-06): a blocked worker becomes an approval in Score.** *Mechanism verified live.*
     - Detect: the bridge plugin's `post_tool_call` in a worker (`HERMES_KANBAN_TASK` set) sees
       `status: blocked` + "BLOCKED: Command flagged as dangerous …". It recomputes `pattern_key` with Hermes's
       `detect_dangerous_command(command)` and posts an approval (origin `kanban`, `taskId`, redacted command).
       The agent normally blocks the task itself (`kanban_block`, kind `capability`).
     - **Approve once**: Score records a one-shot grant `{taskId, pattern_key}`, comments on the task and
       unblocks it (`hermes kanban comment` / `unblock`). In the next worker for that task, the bridge plugin
       calls `tools.approval.approve_permanent(pattern_key)` **in memory only**, scoped to the process whose
       `HERMES_KANBAN_TASK` matches. It lives and dies with that worker; nothing is written to
       `command_allowlist`. (`approve_session` does **not** work here: unattended mode checks only the
       permanent set.) The grant is marked consumed when the matching `post_tool_call` succeeds.
     - **Always**: also persist the pattern in that profile's `command_allowlist` (via `hermes -p <profile>`
       config tooling, shown as a diff first).
     - **Deny**: comment the denial; the task stays blocked for the human (or gets reassigned).
     - Watch for Hermes's re-block loop guard: a second block for the same reason sends the task to `triage`,
       and the specifier may re-dispatch it. Score must apply the grant **before** unblocking, and show
       `block_loop_detected` events.
     Hermes's own defaults stay unchanged (`single_query_mode: deny`); nothing is auto-approved.
- The "Needs you" column = approvals from sources 1–3, plus tasks blocked with `block_kind` `needs_input`
  (questions, not approvals).
- All approval decisions are idempotent (`requestId` + `Idempotency-Key`). A double click, two tabs, or Telegram
  answering first all end in one terminal state. The UI shows who answered and where.

### D5. Score-owned state (`~/.score/score.db`, node:sqlite, SQL migrations)
`events` (the stream log), `rooms`, `room_members`, `messages` (Score chat), `mentions`, `approvals`,
`agent_style` (color + shape per profile), `runs` (Score-started runs ↔ room/message/task),
`watch_frames` (D6), `settings`. Hermes remains the source of truth for tasks, sessions, profiles, skills and memory;
Score caches nothing it can re-read cheaply.

### D6. Watch = event replay, not remote desktop
- Frames come from the bridge plugin's `pre/post_tool_call` (terminal command + output tail, file path + unified
  diff computed from patch/write args, browser tool screenshots or artifact refs) and from `reasoning.available` /
  interim messages.
- Stored per agent-session in `watch_frames` (size-capped: 64 KB per terminal chunk, images as files under
  `~/.score/media/` with a per-day quota). The scrub timeline is just `seq` order.
- "Take control" in the mock is **out of scope for v1** (no remote desktop). v1 offers "Pause <agent>" and
  "Open in terminal" (copies the `hermes -p … --resume` command).

### D7. Security posture (single-user, local-first)
- The server binds `127.0.0.1` by default. Mutating requests require the `X-Score-Client` header + same-origin check (CSRF).
- Bridge ingest uses a shared secret at `~/.score/bridge.token` (0600), created on first run and read by the plugin.
- Score **never** reads `~/.hermes/.env`, `auth.json` or key files. Provider status comes from `hermes` CLI
  status output with secrets redacted by Hermes. Key edits shell out to `hermes auth`/`config` commands.
- Approval payloads are already redacted by Hermes (`_redact_approval_command`); Score stores them as received.

### D8. Front end
- React 19 + Vite + TypeScript, React Router, TanStack Query for snapshots, one `useStream()` hook that patches
  the Query cache from SSE events. No global state library.
- Design tokens as CSS custom properties (`--ground #ECEEF2`, `--ink #12131A`, `--radius-card 28px`, agent palette).
  Fonts via `@fontsource/{bricolage-grotesque,hanken-grotesk,jetbrains-mono}`, bundled; no Google requests.
  Agents always render as color **+** shape (circle-dot, triangle, diamond, square, …).
- Flow graph: custom SVG with layered auto-layout (seeded from Studio's Kahn layering) and pan/zoom/fit. No graph
  library unless the layout outgrows ~200 lines (React Flow is MIT if needed).
- Charts (Reports): hand-rolled SVG components; no chart library in v1.

### D9. Shipping defaults
Neutral example agents only: `lead` (violet, circle-dot), `builder` (jade, triangle), `reviewer` (saffron,
diamond), `designer` (coral, square). Persona names live only in the user's local Hermes profiles and in
`~/.score`. The design PNGs (which show personas) stay in `docs/design/` as reference and are never used as fixtures.

## 3. Alternatives considered

| Option | Why not (for v1) |
|---|---|
| WebSocket for everything | Needs our own resume/ack protocol; SSE + REST covers it |
| Python sidecar service | Can't see in-process hooks either; the plugin is the right place for Python |
| Writing kanban.db directly | Bypasses claims, dispatcher and notify; schema is internal |
| Hermes dashboard API (`hermes dashboard`) as backend | Separate process with its own auth, built for one UI; useful later for SOUL and model edits via `/api/profiles/*` |
| Studio's browser-run DAG | Superseded by Kanban dependencies + dispatcher |
| Mirroring rooms into Hermes `hosted_rooms` | Multi-host feature with grants; revisit after v1 |

## 4. Risks

| Risk | Mitigation |
|---|---|
| Hook payloads differ from source reading | Verified in L4/L5; fixtures in `docs/spike/`; contract tests on captured payloads |
| Bridge relies on non-public Hermes functions (`resolve_gateway_approval`, `approve_permanent`, `detect_dangerous_command`) | All calls live in one plugin module with a version check; the upgrade drill re-runs the L4/L5 scenarios |
| In-process `resolve_gateway_approval` is not a public API | Isolated in the plugin; fall back to exclusive transport (public contract) |
| Gateway must serve every profile | Setup checks `served_profiles`; Settings shows unserved agents |
| `node:sqlite` stability on Node 24 | Read-only use only; `better-sqlite3` (MIT) is a drop-in fallback |
| Hermes upgrades change event names | `translate.ts` + recorded-fixture tests; version gate |

## Review log
- _pending_: `/codex:adversarial-review` with focus "event stream design, approval routing, Hermes adapter
  boundary, Score DB schema". Findings and responses go here before this doc is marked final.
