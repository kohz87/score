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
  phase: 'guardian_evaluating' | 'escalated' | 'human_pending' | 'decided' | 'executed' | 'blocked' | 'withdrawn' | 'expired'
  linkedTo: string | null      /* guardian stage → the human approval it escalated into (UI shows that one) */
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
  | { kind: 'image'; mediaId: string }                 // an uploaded image, served by GET /api/media/:mediaId
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
| `room.upserted` | `Room` | Chat rooms list |
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
| `brief.upserted` | `BriefSummary` | Flow brief picker and header; refetch that brief's graph |
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
- **Remote access mode** (`SCORE_REMOTE=1`, ARCHITECTURE D7.2; absent in local mode). The server denies every request that
  lacks a paired session except this exact public list: `POST /api/session/pair`, `GET /api/session` (boolean only),
  `GET /api/health` (`{ ok, contract }` only) and the built static web assets (`GET` only). HEAD, encoded aliases, previews,
  `/api/stream`, media and all other routes return `401 not_paired`; a Host not in `SCORE_PUBLIC_ORIGINS` returns `403`.
  Mutations also need an allowed `Origin` (missing or `null` is refused). Private responses carry `Cache-Control: no-store`.
  Sessions expire after 7 days idle or 30 days absolute (stream heartbeats do not renew). Revocation and expiry close that
  session's open `/api/stream` connections. Bridge routes (`/bridge/v1/*`) are served only on a separate loopback listener.
  - `GET /api/session/browsers` → `{ items: { id: uuid; label: string; address: string; createdAt: iso; lastSeenAt: iso;
    expiresAt: iso; current: boolean }[] }` (`PairedBrowsersSchema`). `id` is a management id, never a credential.
  - `DELETE /api/session/browsers/:id` → `204` (revokes that browser; idempotent).
- `GET /api/search?q=` → `{ items: { kind: 'agent'|'task'|'room'|'message'|'command'|'setting'; id: string;
  label: string; hint: string | null; ref: Ref | { kind: 'route'; path: string } }[] }` (⌘K palette)

## 4. Now

### Score view
- **S** `GET /api/now?from=<iso>&to=<iso>` →
  ```ts
  { asOfSeq: number; now: string; paused: boolean /* Pause everyone is on */
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
             state: 'done' | 'working' | 'needs_you' | 'planned' | 'failed'; subtitle: string /* "reviewer, 2 passes" */
             taskId: string | null; layout: { col: number; row: number } /* server hint; client may re-layout */ }[]
    edges: { id: string; from: string; to: string; kind: 'flow' | 'handoff' | 'review' | 'sent_back' | 'planned'
             label: string | null }[]
    stats: { runningSec: number; steps: number; handoffs: number; spendUsd: number | null; eta: string | null }
    notice: string | null /* the brief's agents also worked on tasks not linked to it; links stay exact */ }
  ```
- **S** `GET /api/flow/nodes/:nodeId` → `{ node; description: string; steps: TaskStep[]; approval: Approval | null
  run: RunSummary | null; model: string | null; tools: string[]; watch: { agentId; thumbnail: string | null; front: string } | null }`
- **S** `GET /api/briefs/:briefId/log?agent=&kind=tool|all&cursor=` → `{ items: LogLine[]; nextCursor }`
  `type LogLine = { id; at; agentId; kind: 'tool' | 'message' | 'handoff' | 'approval' | 'system'; text }`
- **H** `POST /api/briefs/:briefId/pause` / `/resume` → `BriefSummary`. Pause holds Score's queue for the brief and blocks
  its not-started tasks (`hermes kanban block`); running steps finish. Resume unblocks only what Score blocked.
- **H** `POST /api/flow/nodes/:nodeId/stop` → `{ ok: true }`: stops that node's active run (409 when nothing is running).
- **H** `POST /api/rooms/:roomId/messages/:messageId/plan/start` → `{ briefId; taskIds: string[] }`: creates one Kanban task
  per plan step of that `plan` message (idempotent per message).
- A brief is a human room message plus what it causes (`briefId` = that message id; turns, hand-offs, and tasks Score
  created for it or their Kanban children). Node ids: `brief:<id>`, `task:<taskId>`, `turn:<messageId>`. Status is
  derived (`paused` > `running` > `failed` > `done`). Links are exact only; see `docs/reviews/2026-10-08-3.4-briefs-design-lead.md`.

### Watch view (event replay)
- **S** `GET /api/agents/:agentId/watch?from=<seq>&limit=` →
  ```ts
  { asOfSeq; agent: AgentSummary; live: boolean /* an active run right now */
    sessionId: string | null /* latest Hermes session: Watch's Open in terminal copies `hermes -p <agent> --resume <session>` */
    frames: WatchFrame[]; markers: { seq: number; at: string; kind: 'command' | 'file' | 'browser' | 'asked' }[] }
  type WatchFrame = { seq: number; at: string; agentId: AgentId; runId: string | null; surface: 'terminal' | 'editor' | 'browser'
    terminal?: { cwd: string; command: string; output: string /* tail, ≤64 KB */; status: 'running' | 'ok' | 'error' | 'paused' }
    editor?: { path: string; diff: string /* unified */; language: string | null }
    browser?: { url: string; title: string | null; imageUrl: string | null /* /api/media/:id */ }
    caption: string /* "Checked the latest ws version" */ }
  ```
- `GET /api/media/:mediaId` → image bytes (screenshots).
- **S** `GET /api/watch/overview` → `{ items: { agent: AgentSummary; thumbnail: string | null; status: string; live: boolean
  surface: 'terminal' | 'editor' | 'browser' | null /* last frame, for a miniature */ }[] }`
- Frames are upserted by `seq` (per agent); a terminal frame is re-emitted with the same `seq` when it finishes. Schemas live in
  `packages/contract/src/watch.ts`. The Flow inspector's `watch` field carries the step agent's last frame surface (null when it has none).
- **H** `POST /api/agents/:agentId/pause` / `/resume` → `AgentSummary` (status `paused` while held). Pause holds Score's dispatch
  queue for that agent and blocks its not-started Kanban tasks (`hermes kanban block`); a running turn finishes. Resume unblocks only
  what Score blocked. Same semantics as brief pause.

## 5. Chat

- **S** `GET /api/rooms` → `{ asOfSeq; rooms: Room[]; directs: Room[] }`
- `POST /api/rooms` `{ name: string; leadAgentId?: AgentId; members?: AgentId[] }` → `Room`
- `PATCH /api/rooms/:roomId` `{ name?, leadAgentId?, members? }` → `Room`
- **S** `GET /api/rooms/:roomId` → `{ asOfSeq; room: Room; filesInPlay: string[]
  learned: { text: string; savedTo: AgentId[]; at: string }[] }`
- **S** `GET /api/rooms/:roomId/messages?before=<cursor>&limit=50` → `{ asOfSeq; items: Message[]; nextCursor }`
- `POST /api/rooms/:roomId/messages`
  ```ts
  req: { text: string; to?: AgentId[] /* explicit "To" chips; @mentions in text are merged */
         planFirst?: boolean; model?: string /* one-shot /model */; attachments?: { mediaId: string }[] }
  res: { message: Message; routedTo: AgentId[]; command: CommandResult | null }
  ```
  Text starting with a slash command is parsed server-side:

  | Command | Syntax | Effect | `CommandResult` |
  |---|---|---|---|
  | `/assign` | `/assign @agent <title> [-- body]` | creates a Kanban task | `{ kind: 'assign', taskId, taskKey }` |
  | `/routine` | `/routine @agent <schedule> <prompt>` | creates a cron job | `{ kind: 'routine', routineId }` |
  | `/remember` | `/remember [@agent…] <fact>` | writes agent memory | `{ kind: 'remember', agentIds }` |
  | `/skill` | `/skill @agent <name>` (use) · `/skill install <name>` | loads or installs a skill | `{ kind: 'skill', name, installed: boolean }` |
  | `/model` | `/model <model> <message…>` | runs this message on another model | `{ kind: 'model', model }` |
- `GET /api/commands` → `{ items: { name: string; usage: string; description: string }[] }` (slash menu)
- **H** `POST /api/media` (multipart, one part named `file`) → `201 { mediaId: string; name: string; size: number;
  contentType: string }`. Types come from the bytes (png, jpeg, gif, webp); `400` empty or malformed, `413` over 8 MB,
  `415` unsupported or contradicting type, `507 media_quota_exceeded`. Messages reference uploads with an `image`
  part (at most 8 per message).

## 6. Approvals

- **S** `GET /api/approvals?status=pending|all&agent=&cursor=` → `{ asOfSeq; items: Approval[]; nextCursor }`
- **S** `GET /api/approvals/:approvalId` → `Approval` (`404 not_found`). Same view as a list item, for approvals beyond
  the first page; the card reads it by id and then follows `approval.updated`.
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
- **H** `POST /api/tasks/:taskId/actions`
  `{ action: 'start' | 'block' | 'unblock' | 'request_review' | 'request_changes' | 'complete' | 'archive' | 'comment'; text?: string }`
  → `200 { taskId; action; hermesStatus: string }` after the Hermes CLI accepted it; the task's new state arrives on the
  stream (`task.upserted`). `409 conflict` when the Hermes state machine rejects the transition (e.g. `unblock` on a
  task that isn't blocked). `501 not_implemented` for actions not built yet (only `comment` and `unblock` exist after
  1.13c; the rest arrive with Phase 2 Tasks).

## 8. Team

- **S** `GET /api/agents` → `{ asOfSeq; items: AgentSummary[] }`
- **H** `POST /api/agents/preview` → `AgentPreview` (§8 lifecycle below).
- **H** `POST /api/agents` `{ id; name; role; style; model; provider?; cloneFrom?; previewHash; confirmInheritance? }` → `202 AgentOperation`.
  `provider` (a provider id from `GET /api/models`) is set with the model; preview takes the same fields.
- **H** `PATCH /api/agents/:agentId` `{ name?; role? }` → `AgentDetail`. Name is a Score display name; profile id never changes. Role is nonempty description text.
- **H** `DELETE /api/agents/:agentId` `{ typedName; previewHash }` → `202 AgentOperation`.
- `GET /api/agents/operations/:opId` → `AgentOperation` (paired session required).
- **H** `POST /api/agents/operations/:opId/retry` → `AgentOperation`: runs the failed step again when `retryable` (a recorded
  error on a step whose repeat is harmless: model, permissions, enable bridge, readiness, export, identity purge,
  retire); otherwise `409`. Creating the profile, installing the plugin and deleting it are never repeated.

Lifecycle schemas live in `packages/contract/src/profiles.ts`. Preview accepts `{ kind: 'create', id, name, role,
style, model, cloneFrom? }` or `{ kind: 'delete', agentId }`. Canonical names are lowercase ASCII letters/digits,
underscore or hyphen, 1–64 characters with an alphanumeric first character; `default` and retired names are reserved.
Preview returns `{ kind; targetName; hash; inherited: { memories: string[]; skills: string[]; plugins: string[];
approvalSettings: string[]; credentialsPresent: string[] }; effects: string[]; blockers: string[];
pendingWork: { activeRuns; queuedTurns; pendingApprovals; assignments; disposition }; exportPath: string|null }`.
Inheritance lists contain names only, never credential values or memory contents. Unknown inventory blocks cloning.
Create/delete recompute the preview; a stale hash is `409 conflict`. Cloning requires `confirmInheritance: true`.
All mutations accept Idempotency-Key receipts. Operations are durable and lock their target through completion or
needs-attention; no automatic adoption, rollback, credential rotation, destructive retry, or gateway restart.
`AgentOperation` is `{ id; kind: 'create'|'delete'; targetName; incarnationId; requestHash;
state: 'running'|'needs_attention'|'completed'; steps: { name; state: 'pending'|'running'|'completed' }[];
createdAt; updatedAt; nextStep: string|null; error: string|null; exportPath: string|null }`.
Managed summaries have optional `lifecycle: { state: 'setting_up'|'ready'|'deleting'|'needs_attention'|'removed';
incarnationId; operationId: string|null }`. Only ready agents admit work. Removed agents remain in snapshots for
historical attribution, but have no routing, room membership or lead selection. Lifecycle changes emit only
`agent.updated`. Deletion freezes admissions, refuses active runs, queued turns, pending approvals or unfinished
assignments, verifies a private export first, and retires the name. Exports omit credentials and are not a full undo;
their local path is displayed but their bytes are never served. Retired-name reuse is currently refused until an
incarnation-aware reuse confirmation contract is agreed.
- `PATCH /api/agents/:agentId/style` `{ color?; shape? }` → `AgentSummary`
- **S** `GET /api/agents/:agentId` → `AgentDetail`
  ```ts
  type AgentDetail = AgentSummary & {
    tagline: string /* "Builds what X plans. Working on …" */
    personality: { excerpt: string; source: 'SOUL.md' }; reportsTo: AgentId | null; worksIn: string | null
    rulesFile: 'AGENTS.md' | null
    model: { id: string; label: string; via: string /* "Codex sign-in" */; fallback: string | null } | null /* unreadable */
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
- **H** `PUT /api/agents/:agentId/files/:file` `{ content; etag }` → `{ etag }` (409 `conflict` on etag mismatch, with
  `details: { etag /* current */; diff /* current → submitted */ }`)
- `PUT /api/agents/:agentId/model` `{ model: string; provider?: string }` → `AgentDetail`
- `GET /api/agents/:agentId/skills` → `SkillsResponse` `{ items: AgentDetail['skills'] }` · `POST …/skills` `{ name }`
  (install) → `SkillsResponse` · `PATCH …/skills/:name` `{ enabled }` → `AgentDetail['skills'][number]` ·
  `GET /api/skills/hub?q=` → `SkillHubResponse` `{ items: { name; identifier; source; trust; description }[] }`
- `GET /api/agents/:agentId/memory?q=&cursor=` → `MemoryPage` `{ items: AgentDetail['memory']; nextCursor: string | null }` ·
  `POST …/memory` `{ text }` · `DELETE …/memory/:id`
- `PATCH /api/agents/:agentId/tools/:toolId` `{ enabled }` → `AgentDetail['tools'][number]`
- `GET /api/agents/:agentId/routines` → `{ items: RoutineSummary[] }` · `POST …/routines` `{ title; schedule; prompt }` →
  `RoutineSummary` · `PATCH /api/routines/:id` `{ enabled?; schedule?; prompt? }` → `RoutineSummary` ·
  `DELETE /api/routines/:id` → `{ id }` · `POST /api/routines/:id/run` → `{ id; queued: true }` (runs on the scheduler's next
  tick). Routine ids are `<profile>:<jobId>`. Hermes rejecting a schedule or prompt → `409 conflict` (CLI output stays
  private).
- **H** `PATCH /api/agents/:agentId/permissions/:permId` `{ level }` → the permission row. Stricter only: take back a
  Go-ahead (`asks`) or add a Never (`permId = never:<glob>`, `level: never`); anything looser is `400 not_stricter`.
- **H** `DELETE /api/agents/:agentId/permissions/:permId` → `{ items: AgentDetail['permissions'] }`. Removes this agent's
  own override (a taken-back Go-ahead, or an agent-only Never `never:<glob>`) and re-applies the team baseline to the
  profile through the verified write loop, so the agent is never looser than the team. A rule that belongs to the team
  is `400 not_an_override`; an unknown override `404 not_found`; Hermes refusing the write `409 conflict` (the override
  is kept).
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
  Definitions (from Hermes Kanban history, read-only): a task is finished when `completed_at` falls in the range (day
  buckets in the server's time zone); task time = created → completed; reviewed = had `review_requested`, first pass =
  reviewed and never `changes_requested` (null when nothing was reviewed). Time split per agent (integer %, sum 100):
  working = a run is active (guardian approval time included); waiting on you = open human approvals and `blocked`
  intervals; waiting on another agent = waiting for dependencies (created → `promoted`) and in review
  (`review_requested` → outcome), minus any overlap with working. Spend = Hermes session costs (actual, else estimated);
  null when unknown.
- `GET /api/reports/export.csv?range=` → `text/csv`

## 10. Settings

- `GET /api/settings/providers` → `{ items: { id: string; label: string; status: 'connected' | 'needs_signin' | 'missing'
  detail: string /* "sk-or-••••", "Your ChatGPT plan" */; usedBy: AgentId[];
  signIn?: 'device_code' | 'api_key' | 'terminal' /* how Connect works from the browser (D2.7); absent = terminal */ }[] }`
- **H** `POST /api/settings/providers/:id/connect` → `{ next: 'done' | 'device_code' | 'run_in_terminal'; command?: string; url?: string;
  code?: string; signInId?: string; expiresAt?: string }`. For a `device_code` provider this starts the sign-in (D2.7) and
  returns its link, code and id; `command` is always included as the terminal fallback. A second call while one is
  waiting returns the same sign-in.
- `GET /api/settings/sign-ins/:signInId` → `SignIn` `{ id; providerId; state: 'waiting' | 'connected' | 'failed' | 'expired' |
  'cancelled'; url: string | null; code: string | null; expiresAt: string; message: string | null }` · **H**
  `DELETE /api/settings/sign-ins/:signInId` → `SignIn` (cancelled). In-memory; unknown ids → 404.
- **H** `POST /api/settings/providers/:id/key` `{ apiKey: string; label?: string; acknowledgeInsecure?: boolean }` → the
  provider item, after `hermes auth list` shows the new credential (`409 not_verified` otherwise). Plain-HTTP remote
  without `acknowledgeInsecure: true` → `400 insecure_transport`. The key never appears in any response, log or receipt.
- `GET /api/models?q=` → `{ items: ModelOption[] }`, `ModelOption = { provider: string; providerLabel: string; model: string;
  available: boolean; reason: string | null /* "Not on your plan" */; free: boolean; price: { input: string; output: string } | null }`.
  Models of connected providers only (Hermes model options); `q` matches model or provider label, case-insensitive;
  at most 200 items, available first.
- `POST /api/settings/providers/local` `{ label; baseUrl; model }` → provider item
- `GET /api/settings/connections` → `{ toolServers: { id; label; status: 'ok'|'needs_signin'|'error'; usedBy: AgentId[] | 'everyone' }[]
  messaging: { platform; label; status: 'connected'|'disconnected'; detail: string | null }[] }`
- `POST /api/settings/tool-servers` `{ name; command?: string[]; url?: string }` · `POST /api/settings/messaging/:platform/connect`
- `GET /api/settings/rules` → `{ mode: 'manual' | 'smart' | 'off'; goAhead: Rule[]; askMe: Rule[]; never: Rule[];
  drift: { agentId; differs: boolean }[] }` with `type Rule = { id; label; pattern: string | null; readOnly: boolean }`.
  Hermes mapping (docs/reviews/2026-10-08-2.18-design-lead.md): Go ahead = pattern keys in `command_allowlist`, Ask me
  = known dangerous categories not allowlisted, Never = globs in `approvals.deny`, `mode` = `approvals.mode`. Allowlist
  keys Score doesn't know are `readOnly`. A Never rule's id is `never:<glob>`.
- **H** `PUT /api/settings/rules` `{ mode; goAhead: string[] (pattern keys); never: string[] (globs) }` → the GET shape
  plus `failed: AgentId[]` (profiles whose write didn't verify); `?dryRun=1` → `{ preview: diff }`. The team baseline is
  written to every profile, keeping each agent's stricter overrides. Only `command_allowlist`, `approvals.deny` and
  `approvals.mode` are ever written (read → write → re-read verify, ≤ 3 merges; `409 conflict` after that).
- **H** `POST /api/settings/rules/apply/:agentId` → the GET shape: re-applies the team baseline to a drifted profile.
  These three keys are not editable through the advanced config endpoints.
- `GET /api/settings/plugins` → `{ items: { id; label; enabled: boolean }[] }` · `PATCH /api/settings/plugins/:id` `{ enabled }`
- `GET /api/settings/config?q=` → `{ items: { key: string; value: unknown; file: string; description: string | null }[] }`
  (name and comment search, ≤ 50). Secret-bearing and env-backed keys (credential-shaped names, env/header maps,
  provider and MCP server containers) are never listed or writable; only keys known to the tested Hermes version are.
- `POST /api/settings/config/preview` `{ changes: { key; value }[] }` → `{ diff: string; file: string; hash: string }`
  (`hash` = sha256 over the diff, the current values and the new values). `400` for unknown or protected keys.
- **H** `POST /api/settings/config/apply` `{ changes; expectedDiffHash: string }` → `{ ok: true; restartRequired: boolean }`;
  `409 conflict` when the recomputed hash differs (config changed since the preview; preview again), `502` when Hermes
  refuses or doesn't keep a value.
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
- Every `pre_approval_request` / `post_approval_response` event payload carries a producer-minted **`gateId`** (uuid,
  unique per gate occurrence; the post hook carries its pre hook's id, matched in the same thread) and, on a human
  prompt that follows an unanswered or denied guardian (`smart`) gate in the same thread, **`linkedGateId`**. A fresh
  prompt that replaces a coalesced follower (leader answered `once`; Hermes fires no post hook for it) carries
  **`supersedesGateId`**. The
  hook's own `tool_call_id`/`turn_id`/`session_id` are informational only (not unique). Transport surfaces send their
  id as `transportRequestId`. Gateway human prompts may add `requestId` (see the exactness rule below) and a
  `commandDigest`.
- `GET /bridge/v1/decisions?wait=25` (long-poll; `wait` = integer seconds 0–30, default 25) → `{ items: { deliveryId; leaseId; leaseUntil;
  sessionKey; requestId; choice: ApprovalChoice; reason: string | null }[] }`. Only decisions for approvals **this producer
  reported** are returned. Polls and acks count as producer liveness.
- `POST /bridge/v1/decisions/:deliveryId/ack` `{ leaseId; outcome: 'applied' | 'not_pending' | 'failed'; resolved: number; error?: string }`
  → `204`. `applied` requires `resolved === 1` (exact target). `leaseId` fences stale acks; a late `applied` still
  refines an `unknown` delivery.
- `requestId` in a `pre_approval_request` event is a **guarantee of exactness** by the producer: report it only when
  the queue entry is provably this hook's own; otherwise send `null` (view-only). Never use `register_gateway_settle`:
  it holds one callback per request and would displace the gateway's own (2026-10-07 design review, finding 9).

**Kanban denials** (D4.3, revised 2026-10-07): there are **no** grant endpoints. A Kanban worker's `post_tool_call`
event may carry `kanbanDenial: { patternKey: string; commandDigest: string; taskId: string; runId: number | null }`
when the plugin verified the unattended dangerous-command denial; the server shows it as a view-only approval card.
`enabled.kanbanGrants` in `hello` is reserved and always `false` until Hermes offers a one-shot grant API.

Hook → domain mapping lives in `apps/server/src/hermes/translate.ts`; payload fixtures in
`apps/server/test/fixtures/bridge/` (seeded from `docs/spike/`).
