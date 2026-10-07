# Score API contract (v0)

The **only** interface between `apps/web` and `apps/server`. The front end must not call anything else (no
Hermes URLs, no files). Types are written in TypeScript notation. The executable source of truth is
`packages/contract` (zod), which must match this document. Change this doc first, then the schemas, then both
sides, in the same PR.

Conventions
- Base path `/api`. JSON in and out, UTF-8. Times are ISO-8601 strings (UTC). IDs are opaque strings.
- Every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) must send `X-Score-Client: web` (CSRF guard) and may send
  `Idempotency-Key`. Replays with the same key return the first response.
- Endpoints marked **H** are *human decisions*: they also require the paired session cookie (`score_session`,
  HttpOnly, SameSite=Strict, see §3). Without it they return `401 not_paired`. (ARCHITECTURE D7.1)
- Errors: HTTP 4xx/5xx with `{ "error": { "code": string, "message": string, "details"?: unknown } }`.
  Common codes: `bad_request`, `not_found`, `conflict`, `not_paired`, `hermes_unavailable`, `hermes_unsupported`,
  `feature_disabled` (compatibility gate), `forbidden`.
- Snapshot endpoints (marked **S**) return `asOfSeq: number`, read in the same transaction as the data. Each
  cached query keeps its own `asOfSeq` and applies only stream events with `seq > asOfSeq` (resync rules in §2).
- Lists are cursor-paginated: `?limit=50&cursor=<opaque>` → `{ items: T[], nextCursor: string | null }`.

---

## 1. Shared types

```ts
type AgentId = string                      // = Hermes profile name
type Shape = 'circle-dot' | 'triangle' | 'diamond' | 'square' | 'hexagon' | 'star' | 'pill' | 'cross'
type AgentStyle = { color: string /* #RRGGBB */; shape: Shape }
type AgentStatus = 'idle' | 'working' | 'waiting' /* on a human */ | 'paused' | 'offline' | 'up-next'

type AgentSummary = {
  id: AgentId; name: string; role: string /* "Leads the team" */; style: AgentStyle
  status: AgentStatus; activity: string | null /* "Re-reading the read layer" */
  model: { id: string; label: string } | null
  served: boolean /* gateway serves this profile; false → can't start runs */
}

type Ref =                                   // what an item points at, for "Open in…" links
  | { kind: 'room'; roomId: string } | { kind: 'task'; taskId: string }
  | { kind: 'run'; runId: string }   | { kind: 'brief'; briefId: string }

type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'
type Approval = {
  id: string /* Score operation id */
  origin: 'score-run' | 'gateway' | 'kanban'
  phase: 'guardian_evaluating' | 'human_pending' | 'decided' | 'executed' | 'blocked' | 'withdrawn' | 'expired'
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'withdrawn' | 'unknown'
  actionable: boolean          /* false = no exact target captured; answer on the originating surface */
  agentId: AgentId; title: string /* "Can I install a package?" */
  command: string /* redacted (two layers) */; cwd: string | null
  description: string /* why it was flagged / which rule */
  choices: ApprovalChoice[]    /* kanban: ['once','always','deny'] */
  createdAt: string; expiresAt: string | null
  decision: { choice: ApprovalChoice; by: 'you' | 'guardian' | 'elsewhere' | 'timeout' | 'rule'; at: string } | null
  delivery: 'none' | 'intent' | 'delivering' | 'applied' | 'not_pending' | 'failed' | 'unknown'
  blocking: string /* "Nothing else is blocked; reviewer keeps going" */ | null
  refs: Ref[]
}

type TaskColumn = 'planned' | 'working' | 'in_review' | 'needs_you' | 'done'
type TaskSummary = {
  id: string; key: string /* "T-114" */; title: string; column: TaskColumn
  hermesStatus: string /* raw: triage|todo|scheduled|ready|running|blocked|review|done|archived */
  assignee: AgentId | null; reviewer: AgentId | null; roomId: string | null
  badge: { kind: 'changes_requested' | 'starts_after' | 'blocked' | 'needs_you' | 'triage'; label: string } | null
  progress: number | null /* 0..1 while working */; elapsedSec: number | null
  note: string | null /* "after stream", "tomorrow", "queued", "Wants to install ws@8" */
  updatedAt: string
}
type TaskStep = { id: string; text: string; done: boolean }
type TaskActivity = { at: string; agentId: AgentId | 'you' | null; text: string }
type TaskDetail = TaskSummary & {
  body: string; createdBy: string; steps: TaskStep[]; activity: TaskActivity[]
  pendingApproval: Approval | null; dependsOn: string[]; blocks: string[]; runIds: string[]
}

type Room = { id: string; name: string /* "#dashboard-mvp" */; kind: 'room' | 'direct'
  leadAgentId: AgentId | null /* unaddressed messages go here */; members: AgentId[]
  unread: number; activeAgents: AgentId[]; channels: { platform: string; label: string }[] }

type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'plan'; lanes: { agentId: AgentId; blocks: LaneBlock[] }[]; briefId: string }
  | { kind: 'tools'; summary: string /* "Ran 6 commands and edited 2 files" */; runId: string }
  | { kind: 'file'; path: string; added: number; removed: number }
  | { kind: 'approval'; approvalId: string }
  | { kind: 'review'; verdict: 'approved' | 'changes_requested'; taskId: string | null }
type Message = { id: string; roomId: string; author: { kind: 'you' } | { kind: 'agent'; agentId: AgentId }
  to: AgentId[]; parts: MessagePart[]; createdAt: string; streaming: boolean; refs: Ref[] }

type LaneBlock = { id: string; label: string; state: 'done' | 'working' | 'planned' | 'waiting'
  start: string; end: string | null /* null = open-ended */; taskId: string | null; runId: string | null }
type RunSummary = { id: string; agentId: AgentId; origin: 'score' | 'kanban' | 'gateway' | 'cron'
  status: 'queued' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string; endedAt: string | null; model: string | null; toolsUsed: string[]
  tokens: { input: number; output: number } | null; costUsd: number | null; refs: Ref[]
  gaps: { from: string; to: string | null; reason: string }[] /* unrecoverable intervals */ }
type Handoff = { id: string; from: { agentId: AgentId; blockId: string }; to: { agentId: AgentId; blockId: string }
  kind: 'handoff' | 'review' | 'sent_back'; at: string }
```

## 2. Stream

### `GET /api/stream?since=<seq>&epoch=<epoch>`, `text/event-stream`
- Resume with the `Last-Event-ID` header (wins over `since`). `epoch` is the value from the last `stream.hello`
  the client saw. The first connection has no epoch yet, so the client **manages reconnects itself**:
  close the EventSource on error and open a new one with `?since=<lastSeq>&epoch=<epoch>` (backoff 0.5–10 s).
  A cursor without an epoch is treated as foreign (→ `stream.reset` with reason `epoch`). A fresh connection
  sends neither and gets live events from the head.
- **Durable events**: `id: <seq>`, `event: <type>`, `data: <envelope json>`. `seq` is strictly increasing; gaps
  are allowed. Nothing between replay and live is lost or duplicated (server-side subscription fence).
- **Control frames** (`stream.hello`, `stream.reset`) have **no `id:`**. Comment heartbeat every 15 s (`: hb`).
- `stream.hello` is always first and carries the log `epoch`. The server sends `stream.reset` instead of replaying
  when the cursor's epoch differs, the cursor is older than retention, or it is ahead of the head.
- Slow clients are disconnected (byte budget / write timeout); they reconnect with `Last-Event-ID`.
- **Client resync**: on `stream.reset`, and whenever a query refetches, buffer events; replace the cached snapshot;
  then apply buffered events with `seq > that query's asOfSeq`. Ignore responses from superseded fetches.

Envelope (`data`): `{ seq: number; ts: string; type: string; data: object }`

| type | data | Consumers |
|---|---|---|
| `stream.hello` | `{ epoch: string, headSeq: number, mode: 'live'\|'fake', system: SystemStatus }` (no id) | all |
| `stream.reset` | `{ reason: 'pruned'\|'epoch'\|'future_cursor' }` (no id) | all → resync |
| `system.status` | `SystemStatus` | header banner, Settings |
| `agent.updated` | `AgentSummary` | everywhere agents render |
| `message.created` | `Message` | Chat, Now thread |
| `message.delta` | `{ messageId, roomId, append: string }` | Chat (streaming text) |
| `message.completed` | `{ messageId, roomId }` | Chat |
| `typing` | `{ roomId, agentId, text /* "is re-reading the read layer" */ \| null }` | Chat, Now thread |
| `approval.requested` | `Approval` | Now card, Chat, Flow, Watch, Tasks, header dot |
| `approval.updated` | `Approval` (phase / decision / delivery changes) | same |
| `task.upserted` | `TaskSummary` | Tasks, Now, Flow |
| `task.activity` | `{ taskId, item: TaskActivity }` | task drawer, Flow inspector |
| `lane.upserted` | `{ briefId \| null, agentId, block: LaneBlock }` | Now › Score, Chat plan card |
| `handoff.created` | `{ briefId \| null, handoff: Handoff }` | Score connectors, Flow edges, live log |
| `run.updated` | `RunSummary` | Flow inspector, Watch header |
| `gap.recorded` | `{ source: string; runId: string \| null; from: string; to: string \| null; reason: string }` | Watch, Flow log |
| `log.line` | `LogLine` | Flow live log, Watch "What she's doing" |
| `watch.frame` | `WatchFrame` | Watch |
| `memory.saved` | `{ agentIds: AgentId[], text, source: Ref \| null }` | Chat "Learned here", Team memory |

## 3. System and search

- `GET /api/system` → `SystemStatus`
  ```ts
  type SystemStatus = { mode: 'live' | 'fake'; hermes: { version: string | null; reachable: boolean
    apiServer: boolean; capabilities: string[]; servedProfiles: string[] }
    bridge: { producers: number; lastSeenAt: string | null; isolation: 'in_process' | 'host' | 'unknown' }
    compatibility: { fingerprint: string; tested: boolean; disabled: string[] /* features off by the gate */ }
    agentIsolation: 'same_user' | 'sandboxed' | 'unknown' /* D7.1 threat-model indicator */
    degraded: string[] /* human-readable reasons */ }
  ```
- `POST /api/session/pair` `{ token: string }` → `204` + `Set-Cookie: score_session=…` (one-time token printed by
  the server on its terminal). `GET /api/session` → `{ paired: boolean }`. `DELETE /api/session` → `204`.
- `GET /api/search?q=` → `{ items: { kind: 'agent'|'task'|'room'|'message'|'command'|'setting'; id: string;
  label: string; hint: string | null; ref: Ref | { kind: 'route'; path: string } }[] }` (⌘K palette)

## 4. Now

### Score view
- **S** `GET /api/now?from=<iso>&to=<iso>` →
  ```ts
  { asOfSeq: number; now: string
    headline: { working: number; needsYou: number; text: string /* "Two agents are working. One thing needs you." */ }
    lanes: { agent: AgentSummary; blocks: LaneBlock[] }[]; handoffs: Handoff[]
    focusApproval: Approval | null              // the dark "X is asking" card
    thread: { roomId: string; messages: Message[] } | null   // "Latest from the room"
    madeToday: { title: string; ref: Ref; files: { path: string; added: number; removed: number }[]
                 checks: { label: string; agentId: AgentId; ok: boolean }[] }[] }
  ```
- `POST /api/team/pause` / `POST /api/team/resume` → `{ paused: boolean; affectedRuns: number }`
- Composer: same as `POST /api/rooms/:roomId/messages`, with `roomId` = the current room.

### Flow view
- **S** `GET /api/briefs?status=active|recent` → `{ items: BriefSummary[] }`
  `type BriefSummary = { id; title; roomId; startedAt; startedBy: 'you' | AgentId; status: 'running'|'paused'|'done'|'failed' }`
- **S** `GET /api/briefs/:briefId/flow` →
  ```ts
  { asOfSeq; brief: BriefSummary
    nodes: { id: string; kind: 'brief' | 'step'; title: string; agentId: AgentId | null
             state: 'done' | 'working' | 'needs_you' | 'planned' | 'failed'; subtitle: string /* "Fern, 2 passes" */
             taskId: string | null; layout: { col: number; row: number } /* server hint; client may re-layout */ }[]
    edges: { id: string; from: string; to: string; kind: 'flow' | 'handoff' | 'review' | 'sent_back' | 'planned'
             label: string | null }[]
    stats: { runningSec: number; steps: number; handoffs: number; spendUsd: number | null; eta: string | null } }
  ```
- **S** `GET /api/flow/nodes/:nodeId` → `{ node; description: string; steps: TaskStep[]; approval: Approval | null
  run: RunSummary | null; model: string | null; tools: string[]; watch: { agentId; thumbnail: string | null; front: string } | null }`
- **S** `GET /api/briefs/:briefId/log?agent=&kind=tool|all&cursor=` → `{ items: LogLine[]; nextCursor }`
  `type LogLine = { id; at; agentId; kind: 'tool' | 'message' | 'handoff' | 'approval' | 'system'; text }`
- `POST /api/briefs/:briefId/pause` / `/resume`, `POST /api/flow/nodes/:nodeId/stop` → `{ ok: true }`

### Watch view (event replay)
- **S** `GET /api/agents/:agentId/watch?from=<seq>&limit=` →
  ```ts
  { asOfSeq; agent: AgentSummary; live: boolean
    frames: WatchFrame[]; markers: { seq: number; at: string; kind: 'command' | 'file' | 'browser' | 'asked' }[] }
  type WatchFrame = { seq: number; at: string; agentId: AgentId; runId: string | null; surface: 'terminal' | 'editor' | 'browser'
    terminal?: { cwd: string; command: string; output: string /* tail, ≤64 KB */; status: 'running' | 'ok' | 'error' | 'paused' }
    editor?: { path: string; diff: string /* unified */; language: string | null }
    browser?: { url: string; title: string | null; imageUrl: string | null /* /api/media/:id */ }
    caption: string /* "Checked the latest ws version" */ }
  ```
- `GET /api/media/:mediaId` → image bytes (screenshots).
- **S** `GET /api/watch/overview` → `{ items: { agent: AgentSummary; thumbnail: string | null; status: string }[] }`
- `POST /api/agents/:agentId/pause` / `/resume` → `AgentSummary`

## 5. Chat

- **S** `GET /api/rooms` → `{ asOfSeq; rooms: Room[]; directs: Room[] }`
- `POST /api/rooms` `{ name: string; leadAgentId?: AgentId; members?: AgentId[] }` → `Room`
- `PATCH /api/rooms/:roomId` `{ name?, leadAgentId?, members? }` → `Room`
- **S** `GET /api/rooms/:roomId` → `{ asOfSeq; room: Room; filesInPlay: string[]
  learned: { text: string; savedTo: AgentId[]; at: string }[] }`
- **S** `GET /api/rooms/:roomId/messages?before=<cursor>&limit=50` → `{ items: Message[]; nextCursor }`
- `POST /api/rooms/:roomId/messages`
  ```ts
  req: { text: string; to?: AgentId[] /* explicit "To" chips; @mentions in text are merged */
         planFirst?: boolean; model?: string /* one-shot /model */; attachments?: { mediaId: string }[] }
  res: { message: Message; routedTo: AgentId[]; command: CommandResult | null }
  ```
  Text starting with a slash command is parsed server-side:

  | Command | Syntax | Effect | `CommandResult` |
  |---|---|---|---|
  | `/assign` | `/assign @agent <title> [-- body]` | creates a Kanban task | `{ kind: 'assign', taskId }` |
  | `/routine` | `/routine @agent <schedule> <prompt>` | creates a cron job | `{ kind: 'routine', routineId }` |
  | `/remember` | `/remember [@agent…] <fact>` | writes agent memory | `{ kind: 'remember', agentIds }` |
  | `/skill` | `/skill @agent <name>` (use) · `/skill install <name>` | loads or installs a skill | `{ kind: 'skill', name, installed: boolean }` |
  | `/model` | `/model <model> <message…>` | runs this message on another model | `{ kind: 'model', model }` |
- `GET /api/commands` → `{ items: { name: string; usage: string; description: string }[] }` (slash menu)
- `POST /api/media` (multipart) → `{ mediaId: string; name: string; size: number; contentType: string }`

## 6. Approvals

- **S** `GET /api/approvals?status=pending|all&agent=&cursor=` → `{ asOfSeq; items: Approval[]; nextCursor }`
- **H** `POST /api/approvals/:approvalId/decision` `{ choice: ApprovalChoice; note?: string }` → `202 Approval`
  with `delivery: 'intent'|'delivering'`; the outcome arrives as `approval.updated`.
  `409 conflict` (current `Approval` in `details`) if already decided or `actionable: false`.
  `403 feature_disabled` when the compatibility gate disables that origin.
- "Always allow installs for X" = `choice: 'always'` when offered; otherwise the UI links to Rules (§9).

## 7. Tasks

- **S** `GET /api/tasks?room=&agent=&needsYou=true&column=` → `{ asOfSeq; columns: Record<TaskColumn, TaskSummary[]> }`
- **S** `GET /api/tasks/:taskId` → `TaskDetail`
- `POST /api/tasks` `{ title; body?; assignee?: AgentId; reviewer?: AgentId; roomId?; dependsOn?: string[]; steps?: string[] }` → `TaskDetail`
- `PATCH /api/tasks/:taskId` `{ title?; body?; assignee?; reviewer?; steps?: TaskStep[] }` → `TaskDetail`
- `POST /api/tasks/:taskId/actions`
  `{ action: 'start' | 'block' | 'unblock' | 'request_review' | 'request_changes' | 'complete' | 'archive' | 'comment'; text?: string }`
  → `TaskDetail` (409 when the Hermes state machine rejects the transition)

## 8. Team

- **S** `GET /api/agents` → `{ asOfSeq; items: AgentSummary[] }`
- `POST /api/agents` `{ id: string; name: string; role: string; style: AgentStyle; model?: string; cloneFrom?: AgentId }` → `AgentDetail`
- `PATCH /api/agents/:agentId/style` `{ color?; shape? }` → `AgentSummary`
- **S** `GET /api/agents/:agentId` → `AgentDetail`
  ```ts
  type AgentDetail = AgentSummary & {
    tagline: string /* "Builds what X plans. Working on …" */
    personality: { excerpt: string; source: 'SOUL.md' }; reportsTo: AgentId | null; worksIn: string | null
    rulesFile: 'AGENTS.md' | null
    model: { id: string; label: string; via: string /* "Codex sign-in" */; fallback: string | null }
    skills: { name: string; enabled: boolean }[]
    memory: { id: string; text: string; source: string; at: string }[]       // latest few
    tools: { id: string; label: string; kind: 'builtin' | 'mcp'; enabled: boolean }[]; helpersMax: number | null
    routines: RoutineSummary[]
    channels: { platform: string; label: string; connected: boolean }[]
    permissions: { id: string; label: string; level: 'allowed' | 'asks' | 'never'; inherited: boolean }[] }
  type RoutineSummary = { id; title; schedule: string /* "1h" */; description; lastRunAt: string | null; enabled: boolean }
  ```
- `GET /api/agents/:agentId/files/:file` (`file` ∈ `SOUL.md|AGENTS.md`) → `{ content: string; etag: string }`
- `POST /api/agents/:agentId/files/:file/preview` `{ content }` → `{ diff: string }`
- **H** `PUT /api/agents/:agentId/files/:file` `{ content; etag }` → `{ etag }` (409 on etag mismatch)
- `PUT /api/agents/:agentId/model` `{ model: string; provider?: string }` → `AgentDetail`
- `GET /api/agents/:agentId/skills` · `POST …/skills` `{ name }` (install) · `PATCH …/skills/:name` `{ enabled }` · `GET /api/skills/hub?q=`
- `GET /api/agents/:agentId/memory?q=&cursor=` · `POST …/memory` `{ text }` · `DELETE …/memory/:id`
- `PATCH /api/agents/:agentId/tools/:toolId` `{ enabled }` → `AgentDetail['tools'][number]`
- `GET /api/agents/:agentId/routines` · `POST …/routines` `{ title; schedule; prompt }` · `PATCH /api/routines/:id` `{ enabled?; schedule?; prompt? }` · `DELETE /api/routines/:id` · `POST /api/routines/:id/run`
- **H** `PATCH /api/agents/:agentId/permissions/:permId` `{ level }` (only stricter than team rules; 400 otherwise)
- `GET /api/agents/:agentId/history?cursor=` → `{ items: { sessionId; title; model; messages: number; tokens: number; costUsd: number | null; at: string; ref: Ref | null }[]; nextCursor }`

## 9. Reports

- `GET /api/reports?range=today|7d|30d` →
  ```ts
  { range; summary: string
    totals: { tasksFinished: number; runs: number; firstPassRate: number | null; medianTaskSec: number | null; spendUsd: number | null }
    byDay: { date: string; perAgent: Record<AgentId, number> }[]
    timeSplit: { agentId; workingPct: number; waitingOnYouPct: number; waitingOnAgentPct: number }[]
    byAgent: { agentId; finished: number; runs: number; medianSec: number | null; firstPassRate: number | null /* null = n/a, reviews */; spendUsd: number | null }[]
    approvals: { asked: number; approved: number; denied: number; medianWaitSec: number | null; insight: string | null } }
  ```
- `GET /api/reports/export.csv?range=` → `text/csv`

## 10. Settings

- `GET /api/settings/providers` → `{ items: { id: string; label: string; status: 'connected' | 'needs_signin' | 'missing'
  detail: string /* "sk-or-••••", "Your ChatGPT plan" */; usedBy: AgentId[] }[] }`
- **H** `POST /api/settings/providers/:id/connect` → `{ next: 'done' | 'device_code' | 'run_in_terminal'; command?: string; url?: string; code?: string }`
- `POST /api/settings/providers/local` `{ label; baseUrl; model }` → provider item
- `GET /api/settings/connections` → `{ toolServers: { id; label; status: 'ok'|'needs_signin'|'error'; usedBy: AgentId[] | 'everyone' }[]
  messaging: { platform; label; status: 'connected'|'disconnected'; detail: string | null }[] }`
- `POST /api/settings/tool-servers` `{ name; command?: string[]; url?: string }` · `POST /api/settings/messaging/:platform/connect`
- `GET /api/settings/rules` → `{ goAhead: Rule[]; askMe: Rule[]; never: Rule[] }` with `type Rule = { id; label; pattern: string | null }`
- **H** `PUT /api/settings/rules` `{ goAhead; askMe; never }` → same (writes Hermes approval config via adapter; returns `{ preview: diff }` when `?dryRun=1`)
- `GET /api/settings/plugins` → `{ items: { id; label; enabled: boolean }[] }` · `PATCH /api/settings/plugins/:id` `{ enabled }`
- `GET /api/settings/config?q=` → `{ items: { key: string; value: unknown; file: string; description: string | null }[] }`
- `POST /api/settings/config/preview` `{ changes: { key; value }[] }` → `{ diff: string; file: string }`
- **H** `POST /api/settings/config/apply` `{ changes; expectedDiffHash: string }` → `{ ok: true; restartRequired: boolean }`
- `GET /api/settings/ui` · `PATCH /api/settings/ui` `{ theme?: 'light' | 'dark' }`

## 11. Internal: bridge plugin ↔ server (not for the front end)

Served under `/bridge/v1` on the same port. Bridge tokens can't call `/api/*`, and browser sessions can't call
`/bridge/*`.

**Handshake**
- `POST /bridge/v1/hello`, auth `Bearer <~/.score/bridge.token>` (bootstrap secret, allowed for this call only):
  ```ts
  req: { profile: string; pid: number; incarnation: string /* random per process */; kanbanTaskId: string | null
         isolation: 'in_process' | 'host' | 'unknown' /* unknown → observe only; actions disabled */
         pluginVersion: string; hermes: { version: string; codeSha: string }
         privateApis: Record<string, boolean> /* which hermes_private functions resolved */ }
  res: { producerToken: string; expiresAt: string; enabled: { gatewayApprovals: boolean; kanbanGrants: boolean; watch: boolean } }
  ```
  Every other call uses `Authorization: Bearer <producerToken>`. The token is scoped to profile, incarnation and
  `kanbanTaskId`, and is renewed by calling `hello` again.

**Events** (all redacted in-plugin with `force=True` before truncation)
- `POST /bridge/v1/events` `{ events: { counter: number; hook: string; at: string; sessionKey: string | null;
  sessionId: string | null; toolCallId: string | null; payload: object }[] }` → `{ ackedThrough: number }`.
  `(incarnation, counter)` is the ingest key; redelivery after a spool drain is harmless.
  Limits: ≤ 200 events and ≤ 2 MiB of request body; each event's `payload` is ≤ 64 KiB serialized. Producers split
  a backlog into byte-bounded requests in counter order. `profile` is `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` and
  `incarnation` `^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$`; identifiers are validated, never redacted. Unknown hooks are
  acknowledged and ignored.

**Gateway approvals** (D4.2)
- The `pre_approval_request` event payload includes the exact `requestId` read via `list_gateway_approvals`
  (or `null` → the operation is not actionable) and a `commandDigest`. Settle callbacks arrive as
  `approval.settled` events with `{ requestId, reason }`.
- `GET /bridge/v1/decisions?wait=25` (long-poll; `wait` = integer seconds 0–30, default 25) → `{ items: { deliveryId; leaseUntil; sessionKey; requestId;
  choice: ApprovalChoice; reason: string | null }[] }`. Only decisions for approvals **this producer reported**
  are returned.
- `POST /bridge/v1/decisions/:deliveryId/ack` `{ outcome: 'applied' | 'not_pending' | 'failed'; resolved: number; error?: string }` → `204`

**Kanban grants** (D4.3)
- `POST /bridge/v1/grants/redeem` `{ taskId; taskRunId: number; commandDigest; toolCallId }` →
  `200 { grantId; patternKey }` or `404 no_grant` / `409 not_eligible` (wrong attempt, expired, already redeemed).
  Allowed only when the producer token's `kanbanTaskId` equals `taskId`.
- `POST /bridge/v1/grants/:grantId/consume` `{ toolCallId; outcome: 'executed' | 'blocked' | 'revoked' }` → `204`

Hook → domain mapping lives in `apps/server/src/hermes/translate.ts`; payload fixtures in
`apps/server/test/fixtures/bridge/` (seeded from `docs/spike/`).
