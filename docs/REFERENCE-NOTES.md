# Reference notes: Hermes Studio vs. Hermes Agent v0.21

What we can learn from (and reuse from) the MIT reference code. All four repos are cloned **outside** this repo:

| Path | Upstream | License | Notes |
|---|---|---|---|
| `../reference/Hermes-Studio` | github.com/JPeetz/Hermes-Studio @ `356b3d5` (2026-07-03) | MIT © 2026 JPeetz; portions © 2026 Eric (outsourc-e) | Studio 1.20.0, a TanStack Start app |
| `../reference/hermes-workspace` | github.com/outsourc-e/hermes-workspace (2026-08-22) | MIT © 2026 Eric (outsourc-e) | The ancestor Studio was forked from |
| `../reference/hermes-agent` | github.com/NousResearch/hermes-agent, **checked out at `e97923c3`** (= the live install) | MIT © 2025 Nous Research | |
| `../reference/hermes-example-plugins` | github.com/NousResearch/hermes-example-plugins | MIT © 2026 Nous Research | Hook, tool and dashboard plugin templates |

EKKOLearnAI/ekko-studio (BSL) was **not** read or fetched, and must never be.

> **Summary.** Studio is a useful map of the territory, but its live-event and approval plumbing was built for a
> v0.8/v0.9 gateway (plus a FastAPI fork, `webapi/`, that upstream never had) and has drifted from v0.21.
> Its three best ideas carry over to Score: a server-side event bus with `Last-Event-ID` replay, a capability probe,
> and a DAG layered by Kahn's algorithm. Its approval handling does **not** carry over.

---

## 1. Connecting to the Hermes gateway

**Studio** (`src/server/gateway-capabilities.ts`, `src/server/hermes-api.ts`):
- Plain HTTP `fetch` to `HERMES_API_URL` (default `http://127.0.0.1:8642`, auto-falls back to `:8643`), optional
  `Authorization: Bearer $HERMES_API_TOKEN`.
- **Capability probe**: hits `/health`, `/v1/chat/completions` (GET → 405 = exists), `/v1/models`, `/api/sessions`,
  `/api/sessions/__probe__/chat/stream`, `/api/skills`, `/api/memory`, `/api/config`, `/api/jobs`. It caches the
  result for 120 s and derives a chat mode: `enhanced-hermes` (session API), `portable` (OpenAI-compatible only),
  or `disconnected`.
- Management features (profiles, memory, skills, knowledge) mostly **read `~/.hermes` files directly**
  (`profiles-browser.ts`, `memory-browser.ts`) and shell out (`hermes-agent.ts` spawns the gateway; it reads
  `~/.hermes/.env`, which we must not copy: Score never reads secrets).
- Crew and workflow state lives in `.runtime/*.json` inside the Studio checkout.

**What changed by v0.21** (verified in source at `e97923c3`):
- The API server is an opt-in gateway *platform* (`platforms.api_server.enabled`), aiohttp-based, in
  `gateway/platforms/api_server*.py`. It is not enabled on the live install.
- Health is `/v1/health`, and there is a first-class **`GET /v1/capabilities`**. A probe should prefer that over
  Studio's 404-sniffing.
- Studio's `enhanced-hermes` routes still exist upstream (`/api/sessions`, `…/messages`, `…/chat`,
  `…/chat/stream`, `…/fork`), plus `/api/jobs*` and `/api/model/options`. `/api/skills`, `/api/memory`,
  `/api/config` are **not** API-server routes (skills moved to `/v1/skills`; memory and config live in the
  separate dashboard app, `hermes dashboard`, under `hermes_cli/web_routers/`).
- **Multi-profile**: every API route is also mounted under **`/p/{profile}/…`**, scoped to that profile's home. The
  gateway is multi-profile (`served_profiles`). Studio has no notion of this; it treats "profile" as a file-explorer
  scope.
- **Runs API** (`/v1/runs`, `/events`, `/approval`, `/steer`, `/stop`) with idempotency keys, per-run ownership,
  and a 1000-event replay buffer. Studio proxies `/v1/runs/{id}/events` (`hermes-runs.$runId.events.ts`) but drops
  auth headers and `Last-Event-ID`, and uses it only for "jobs".
- The Studio compatibility doc (`docs/HERMES_AGENT_COMPATIBILITY.md`) points at the **outsourc-e fork**
  (`outsourc-e/hermes-agent`) and expects a `webapi/` directory (`hermes-agent.ts: resolveHermesAgentDir`). Upstream
  has no `webapi/`. Treat that doc as unreliable.

**Score takeaway**: one adapter talks to the API server (`/p/{profile}/v1/*`) for actions and reads SQLite +
files for state. Probe `/v1/capabilities` once at startup and on reconnect.

## 2. Streaming events

**Studio**:
- Per-message streaming: `POST /api/send-stream` → upstream `POST /api/sessions/{id}/chat/stream`; it parses SSE by hand
  (`hermes-api.ts:streamChat`) and translates events (`send-stream.ts:550-850`: `run.started`, `message.started`,
  `assistant.delta`, `assistant.completed`, `tool.pending|started|calling|running|progress|completed|failed`,
  `artifact.created`, `memory.updated`, `skill.loaded`, `approval.required|tool.approval|exec.approval`,
  `run.completed`).
- Global fan-out: an in-process singleton **event bus** (`chat-event-bus.ts`, kept on `globalThis` to survive Vite
  HMR). Events are persisted to SQLite with a sequence number **before** broadcast (`event-store.ts`) and exposed at
  `GET /api/chat-events` as SSE with `id: <seq>`. On reconnect the browser's `Last-Event-ID` triggers a replay of
  missed events, followed by a `connected {replayed: n}` frame and a 30 s heartbeat. **This pattern is directly reusable.**
- Only runs that **Studio itself started** produce events. A Telegram, cron or Kanban run is invisible until you
  reload history.

**v0.21 drift**:
- The session stream now emits `approval.request` (not `approval.required`/`tool.approval`/`exec.approval`), so
  **Studio silently misses approvals on v0.21**. It also emits `assistant.commentary`, `reasoning.available`,
  `run.queued`, `run.cancelled`.
- `/v1/runs/{id}/events` uses `message.delta` / `message.interim` (not `assistant.*`), adds `subagent.*`,
  `replay.truncated` and `approval.responded`, and tags every frame with `seq`.
- The real way to see **every** run live is a **plugin** with `pre/post_tool_call`, `on_stream_*`, `subagent_*`,
  `on_kanban_*` and approval hooks. Studio has no plugin component.
- `state.db` now flushes after every tool result (see SPIKE (a)), so DB tailing is a viable fallback.

**Score takeaway**: reuse the *bus + persisted seq + Last-Event-ID replay* design, but with **one** stream
for the whole app. Feed it from (1) run SSE for runs Score starts, (2) a Score bridge plugin for everything else,
(3) SQLite tailing as backstop and for history.

## 3. Resolving approvals

**Studio**:
- The client keeps approvals in `sessionStorage` (`src/lib/approvals-store.ts`). They are lost when the tab closes and
  never seen by other tabs.
- `POST /api/approvals/{id}/approve|deny` (`approvals.$approvalId.approve.ts`) first tries
  `POST {HERMES}/api/sessions/{sessionKey}/approve` (**does not exist upstream**), then falls back to **sending
  `/approve` or `/deny` as a chat message** to the session. The session key is parsed out of an ID shaped
  `"<sessionKey>:<uuid>"`, defaulting to `"main"`.
- Scope `once | session | always` maps to `/approve`, `/approve session`, `/approve always`.

**v0.21 reality** (details in SPIKE (b)):
- Runs API: `approval.request` event (redacted command, `choices`, optional `request_id`) and
  `POST /v1/runs/{id}/approval {"choice": "once"|"session"|"always"|"deny", "request_id"?, "all"?}`.
- Approvals from other surfaces are held **in-process** (`tools/approval.py:_pending`). They can be reached only by a
  plugin: hooks to observe them, plus either a selected **approval transport** (exclusive: replaces Telegram
  prompts) or `resolve_gateway_approval()` called in-process.
- Unattended contexts (`chat -q`, so all Kanban workers, and cron) **deny instantly by default**. No human sees them.

**Score takeaway**: approvals are server-side state in Score's DB (survives reloads, visible on every screen),
resolved through the adapter by origin: Runs API for our runs, bridge plugin for gateway sessions. Kanban "needs
you" is a separate concept (blocked tasks). Do **not** copy Studio's chat-command fallback.

## 4. Crews and the workflow DAG

**Studio**:
- A *crew* (`crew-store.ts`) is a named list of chat sessions with roles (`coordinator | executor | reviewer |
  specialist`), persona, color and optional profile name. It is stored in `.runtime/crews.json`.
- Dispatch (`crews/$crewId.dispatch.ts`) fires one `POST /api/send-stream` per targeted member, fire-and-forget,
  then watches the shared bus for completions. No Hermes-side coordination.
- The workflow is a per-crew DAG `{tasks:[{id,label,prompt,assigneeId,x,y}], edges:[{from,to}]}`
  (`types/workflow.ts`, `workflow-store.ts`). The server validates edge references and cycles (DFS three-color).
- **Execution happens in the browser** (`screens/crews/components/workflow-builder.tsx`): Kahn topological sort
  into parallel layers → dispatch layer 0 → when every task in a layer reports `run.completed` over SSE, dispatch the
  next layer. Closing the tab stops the workflow. There is no retry, no persistence of run state, and no hand-off of
  outputs between steps beyond what the agents share by themselves.
- `computeAutoLayout` lays nodes out by layer: x = layer × 220, y = index × 120.

**v0.21 reality**:
- Hermes now has a durable, server-side **Kanban** with dependencies (`task_links`), per-profile assignment,
  claims, retries / circuit breaker, review states (`review`, `request-changes`), goal loops, `swarm`
  (parallel workers → verifier → synthesizer), `decompose`, and a dispatcher **inside the gateway**. That is what
  Studio's browser-side DAG was approximating.
- Native `hosted_rooms` (multi-host rooms with grants) exist in `gateway/hosted_rooms*.py` + `shared-state.db`.

**Score takeaway**: don't build a second scheduler. Flow is a **view** over Kanban tasks + `task_links` + live run
state; hand-offs are Kanban assignments, reviews and @mention-triggered runs. Reuse two pieces: the Kahn
layering algorithm (adapted, as the seed for Flow auto-layout) and cycle validation for `task_links` edits.

---

## Reuse candidates (with attribution in THIRD_PARTY_NOTICES.md if copied)

| Studio file | Use in Score | Adaptation |
|---|---|---|
| `src/server/chat-event-bus.ts` + `event-store.ts` + `routes/api/chat-events.ts` | Event hub + SSE endpoint pattern | Rewrite for Fastify; single global stream with typed envelope; no `globalThis` hack needed |
| `src/server/hermes-api.ts:streamChat` (SSE line parser) | Upstream SSE client in the adapter | Add `id:`/`Last-Event-ID` handling, multi-line `data:`, comments |
| `src/server/gateway-capabilities.ts` | Capability probe idea | Use `/v1/capabilities` + `/p/{profile}` |
| `screens/crews/components/workflow-builder.tsx` (`topoLayers`, `wouldCreateCycle`, `computeAutoLayout`) | Flow layout seed, cycle checks | Pure functions in `packages/core`, unit-tested |
| `src/routes/api/crews/$crewId.workflow.ts:hasCycle` | Dependency validation | Same |

Do **not** reuse: the approvals store or approve routes, `hermes-agent.ts` (reads `.env`), the `send-stream.ts`
event translation tables (wrong names for v0.21), or TanStack Start routing (Score uses Fastify + Vite SPA).

## Version map (what targets old Hermes)

| Studio area | Built for | Status on v0.21 |
|---|---|---|
| `/api/sessions` list `{items,total}` shape | v0.18 | ✅ still valid |
| Session chat stream event names | v0.8–v0.9 | ⚠️ approvals missed (`approval.request`), commentary/reasoning ignored |
| `/api/sessions/{key}/approve` | fork only | ❌ never upstream |
| `/api/skills`, `/api/memory`, `/api/config` on :8642 | fork/v0.9 | ❌ moved to `/v1/skills` and the dashboard app |
| `/health` | v0.8 | ⚠️ upstream is `/v1/health` |
| Jobs via `/api/jobs`, run SSE via `/v1/runs` | v0.9+ | ✅ still valid, now profile-prefixable |
| Profiles = `~/.hermes/profiles/<name>` files | v0.8+ | ✅ layout still valid; gateway now serves several profiles at once |
| Crews/workflows as client-orchestrated chats | — | Superseded by Kanban + dispatcher |
