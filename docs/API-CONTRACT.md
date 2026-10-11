# Score API contract (v0)

The **only** interface between `apps/web` and `apps/server`. The front end must not call anything else (no
Hermes URLs, no files). Types are written in TypeScript notation. The executable source of truth is
`packages/contract` (zod), which must match this document. Change this doc first, then the schemas, then both
sides, in the same PR.

Conventions

- Base path `/api`. JSON in and out, UTF-8. Times are ISO-8601 strings (UTC). IDs are opaque strings.
- Every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) must send `X-Score-Client: web` (CSRF guard) and may send
  `Idempotency-Key`. Replays with the same key return the first response.
- Endpoints marked **H** are _human decisions_: they also require the paired session cookie (`score_session`,
  HttpOnly, SameSite=Strict, see §3). Without it they return `401 not_paired`. (ARCHITECTURE D7.1)
- Errors: HTTP 4xx/5xx with `{ "error": { "code": string, "message": string, "details"?: unknown } }`.
  Common codes: `bad_request`, `not_found`, `conflict`, `not_paired`, `hermes_unavailable`, `hermes_unsupported`,
  `feature_disabled` (compatibility gate), `forbidden`, `https_required` (426, plain HTTP in remote mode).
- Snapshot endpoints (marked **S**) return `asOfSeq: number`, read in the same transaction as the data. Each
  cached query keeps its own `asOfSeq` and applies only stream events with `seq > asOfSeq` (resync rules in §2).
- Lists are cursor-paginated: `?limit=50&cursor=<opaque>` → `{ items: T[], nextCursor: string | null }`.

---

## 1. Shared types

```ts
type AgentId = string // = Hermes profile name
type Shape =
  'circle-dot' | 'triangle' | 'diamond' | 'square' | 'hexagon' | 'star' | 'pill' | 'cross'
type AgentStyle = { color: string /* #RRGGBB */; shape: Shape }
type AgentStatus =
  'idle' | 'working' | 'waiting' /* on a human */ | 'paused' | 'offline' | 'up-next'

type AgentSummary = {
  id: AgentId
  name: string
  role: string /* "Leads the team" */
  style: AgentStyle
  status: AgentStatus
  activity: string | null /* "Re-reading the read layer" */
  model: { id: string; label: string } | null
  served: boolean /* gateway serves this profile; false → can't start runs */
  runtime?: Runtime /* PLAN 7.2; absent = 'hermes' */
  runtimeNote?: string /* coding agents: "Claude Code · Uses your Claude plan quota …" for the card */
}
type Runtime = 'hermes' | 'claude-code' | 'codex' | 'opencode'
type CostKind = 'reported' | 'estimated' | 'unknown'

type Ref =
  // what an item points at, for "Open in…" links
  | { kind: 'room'; roomId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'brief'; briefId: string }

type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'
type Approval = {
  id: string /* Score operation id */
  origin: 'score-run' | 'gateway' | 'kanban'
  phase:
    | 'guardian_evaluating'
    | 'escalated'
    | 'human_pending'
    | 'decided'
    | 'executed'
    | 'blocked'
    | 'withdrawn'
    | 'expired'
  linkedTo:
    string | null /* guardian stage → the human approval it escalated into (UI shows that one) */
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'withdrawn' | 'unknown'
  actionable: boolean /* false = no exact target captured; answer on the originating surface */
  agentId: AgentId
  title: string /* "Can I install a package?" */
  command: string /* redacted (two layers) */
  cwd: string | null
  description: string /* why it was flagged / which rule */
  choices: ApprovalChoice[] /* kanban: ['once','always','deny'] */
  createdAt: string
  expiresAt: string | null
  decision: {
    choice: ApprovalChoice
    by: 'you' | 'guardian' | 'elsewhere' | 'timeout' | 'rule'
    at: string
  } | null
  delivery: 'none' | 'intent' | 'delivering' | 'applied' | 'not_pending' | 'failed' | 'unknown'
  blocking: string /* "Nothing else is blocked; reviewer keeps going" */ | null
  refs: Ref[]
}

type TaskColumn = 'planned' | 'working' | 'in_review' | 'needs_you' | 'done'
type TaskSummary = {
  id: string
  key: string /* "T-114" */
  title: string
  column: TaskColumn
  hermesStatus: string /* raw: triage|todo|scheduled|ready|running|blocked|review|done|archived */
  assignee: AgentId | null
  reviewer: AgentId | null
  roomId: string | null
  badge: {
    kind: 'changes_requested' | 'starts_after' | 'blocked' | 'needs_you' | 'triage'
    label: string
  } | null
  progress: number | null /* 0..1 while working */
  elapsedSec: number | null
  note: string | null /* "after stream", "tomorrow", "queued", "Wants to install ws@8" */
  updatedAt: string
}
type TaskStep = { id: string; text: string; done: boolean }
type TaskActivity = { at: string; agentId: AgentId | 'you' | null; text: string }
type TaskDetail = TaskSummary & {
  body: string
  createdBy: string
  steps: TaskStep[]
  activity: TaskActivity[]
  pendingApproval: Approval | null
  dependsOn: string[]
  blocks: string[]
  runIds: string[]
  completedAt?: string | null /* kanban completed_at; "Made today" uses it, not updatedAt */
  briefId?: string | null /* newest brief Score linked this task to (GET /api/tasks/:taskId); "See it in Flow" opens /now/flow/:briefId */
}

type Room = {
  id: string
  name: string /* "#dashboard-mvp" */
  kind: 'room' | 'direct'
  leadAgentId: AgentId | null /* unaddressed messages go here */
  members: AgentId[]
  unread: number
  activeAgents: AgentId[]
  channels: { platform: string; label: string }[]
}

type MessagePart =
  | { kind: 'text'; text: string; via?: 'mcp' }   // via: posted by an agent through Score's MCP server (§13); the UI tags it "via MCP"
  | { kind: 'plan'; lanes: { agentId: AgentId; blocks: LaneBlock[] }[]; briefId: string }
  | { kind: 'tools'; summary: string /* "Ran 6 commands and edited 2 files" */; runId: string }
  | { kind: 'tool'; tool: string; args: string; result: string | null; status: 'running' | 'ok' | 'error' } // one tool call (5.25)
  | { kind: 'thinking'; text: string } // reasoning text, collapsed in the UI (5.25)
  | { kind: 'file'; path: string; added: number; removed: number }
  | { kind: 'image'; mediaId: string } // an uploaded image, served by GET /api/media/:mediaId
  | { kind: 'document'; mediaId: string; name: string; contentType: string; size: number; saved?: { agentId: AgentId; path: string }[] } // an uploaded PDF/DOCX/XLSX/text file (5.30; `file` is taken by changed files)
  | { kind: 'workspace'; agentId: AgentId; path: string } // a reference to a workspace file, not a copy (5.30)
  | { kind: 'approval'; approvalId: string }
  | { kind: 'review'; verdict: 'approved' | 'changes_requested'; taskId: string | null }
  | { kind: 'summary'; coversUntil: MessageId; text: string; stale?: boolean; edited?: boolean } // room summary (7.4a)
type Message = {
  id: string
  roomId: string
  author: { kind: 'you' } | { kind: 'agent'; agentId: AgentId }
  to: AgentId[]
  parts: MessagePart[]
  createdAt: string
  streaming: boolean
  progressAt?: string | null /* streaming agent replies: last sign of life from the run (text, tool, reasoning, approval); absent = createdAt. The web shows "Waiting for the model" after 60 s without it. */
  refs: Ref[]
}

type LaneBlock = {
  id: string
  label: string
  state: 'done' | 'working' | 'planned' | 'waiting'
  start: string
  end: string | null /* null = open-ended */
  taskId: string | null
  runId: string | null
  /* task = a task or any other exact run; brief = a run answering a chat message whose brief has tasks or a plan;
     chat = plain chat replies of one agent, merged into ONE block when less than 5 minutes apart (`id` `chat:<first run>`,
     `runId` null once it covers more than one reply). Task and brief blocks are never merged. Absent in old stored plan
     blocks = task. */
  kind: 'task' | 'brief' | 'chat'
  count?: number /* chat bands: replies covered */
  /* Kanban attempt blocks only (5.17a-1, SCORE_KANBAN_ATTEMPTS=1): `id` is `attempt:<kr id>`, `runId` is null. */
  attemptId?: string
  observationEndedAt?: string | null /* observation stopped here; the block ends here, nothing after counts */
  provenance?: 'proven' | 'partial' /* partial = the claim could not be proven */
  order?: [startedAt: string, upstreamAttemptId: number] /* clients sort by this, never by `id` */
}
type RunSummary = {
  id: string
  agentId: AgentId
  origin: 'score' | 'kanban' | 'gateway' | 'cron'
  status:
    | 'queued'
    | 'running'
    | 'waiting_for_approval'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
  startedAt: string
  endedAt: string | null
  model: string | null
  toolsUsed: string[]
  tokens: { input: number; output: number } | null
  costUsd: number | null
  runtime?: Runtime /* PLAN 7.2; absent = 'hermes' */
  costKind?: CostKind /* coding agents only: 'estimated' = API-price equivalent (a subscription isn't billed per token); 'unknown' = the CLI gave no cost, costUsd is null */
  refs: Ref[]
  gaps: { from: string; to: string | null; reason: string }[] /* unrecoverable intervals */
}
type Handoff = {
  id: string
  from: { agentId: AgentId | null; blockId: string } /* null = the Unattributed lane (5.17a-1) */
  to: { agentId: AgentId | null; blockId: string }
  kind: 'handoff' | 'review' | 'sent_back'
  at: string
}

/* Kanban attempts (PLAN 5.17a-1; everything below exists only with SCORE_KANBAN_ATTEMPTS=1, default off). An attempt
   is Score's own record of one claim-to-close stretch of a Kanban task. It is not a RunSummary: tools, session and model
   are not observed (null, never []). Unknown is explicit everywhere: a null agent is the Unattributed lane, never the
   task's current assignee. */
type TaskRef = {
  taskId: string
  historyId: string /* the board lineage ("history") the task id belongs to */
  current: boolean /* only `current` refs may navigate to /tasks/:id or allow actions */
}
type AttemptSummary = {
  id: string /* opaque `kr_<uuid>`: never parsed, never sorted by */
  kind: 'kanban'
  agentId: AgentId | null /* the frozen claim profile */
  role: 'implementer' | 'reviewer' | null /* from the claim event, never the current assignee */
  status: 'running' | 'completed' | 'failed' | 'blocked' | 'review_handoff' | 'changes_requested' | 'ended_unknown'
  closureReason: string | null
  startedAt: string
  endedAt: string | null
  observationEndedAt: string | null /* observation stopped before the attempt ended: a boundary, never an end time */
  evidence: 'proven' | 'partial'
  taskId: string /* = task.taskId */
  task: TaskRef
  order: [startedAt: string, upstreamAttemptId: number] /* the only valid sort key */
  refusedUpdates: number /* contradicting observations Score refused */
  tools: null
  session: null
  model: null
}
type AttemptDetail = AttemptSummary & {
  taskSnapshot: { title: string /* <= 300 */; status: string; assignee: string | null } | null /* as last observed */
}
type WorkItem = { kind: 'run'; run: RunSummary } | { kind: 'attempt'; attempt: AttemptSummary }
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
- A single event too large to send (frame over 8 MiB; completion `parts` over 256 KiB are omitted at the source) is replaced on the wire by `stream.reset` reason `pruned`, live and in replay, so a reconnect cannot loop on it.
- `stream.hello` is always first and carries the log `epoch`. The server sends `stream.reset` instead of replaying
  when the cursor's epoch differs, the cursor is older than retention, or it is ahead of the head.
- Slow clients are disconnected (byte budget / write timeout); they reconnect with `Last-Event-ID`.
- **Client resync**: on `stream.reset`, and whenever a query refetches, buffer events; replace the cached snapshot;
  then apply buffered events with `seq > that query's asOfSeq`. Ignore responses from superseded fetches.

Envelope (`data`): `{ seq: number; ts: string; type: string; data: object }`

| type                 | data                                                                                          | Consumers                                                |
| -------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `stream.hello`       | `{ epoch: string, headSeq: number, mode: 'live'\|'fake', system: SystemStatus }` (no id)      | all                                                      |
| `stream.reset`       | `{ reason: 'pruned'\|'epoch'\|'future_cursor' }` (no id)                                      | all → resync                                             |
| `system.status`      | `SystemStatus`                                                                                | header banner, Settings                                  |
| `agent.updated`      | `AgentSummary`                                                                                | everywhere agents render                                 |
| `room.upserted`      | `Room`                                                                                        | Chat rooms list                                          |
| `message.created`    | `Message`                                                                                     | Chat, Now thread                                         |
| `message.delta`      | `{ messageId, roomId, append: string }`                                                       | Chat (streaming text)                                    |
| `message.completed`  | `{ messageId, roomId, parts?: MessagePart[] }` (final parts replace the cached message's)     | Chat                                                     |
| `message.deleted`    | `{ roomId, messageId }` (remove it from the cached messages; Score-side only)                  | Chat, Now thread                                         |
| `message.updated`    | `{ roomId, messageId, editedBy?: MessageId \| null, parts?: MessagePart[] }` (`editedBy`: the original of an edit; `parts`: a summary edited or marked stale, replace the cached parts) | Chat                                                     |
| `message.progressed` | `{ roomId, messageId, at }` (a streaming reply's run made a non-text move: tool call, reasoning, approval; set its `progressAt`. Text moves it via `message.delta`) | Chat |
| `room.deleted`       | `{ id: RoomId }` (PLAN 5.36: the room and everything Score kept for it is gone; drop it from the cached lists and leave its page) | Chat, Tasks, Now |
| `session.compacted`  | `SessionCompacted` (PLAN 5.36: the answer to a `…/compact` request; one per `commandId`) | Chat context meter |
| `room.version.created` | `RoomVersion` (a rewind hid the anchor and everything after it; the `message.deleted` events for those messages precede it) | Chat |
| `workflow.run.upserted` | `WorkflowRunSummary` (§15; after every change of a workflow run, which is not announced as `orchestration.upserted`) | Flow › Workflows run view, Now "Needs you" |
| `knowledge.changed`  | `{ path; kind: 'written'\|'moved'\|'deleted'\|'restored'; to; by: 'you'\|'outside'\|{agentId} }` | Knowledge                                                |
| `typing`             | `{ roomId, agentId, text /* "is re-reading the read layer" */ \| null }`                      | Chat, Now thread                                         |
| `approval.requested` | `Approval`                                                                                    | Now card, Chat, Flow, Watch, Tasks, header dot           |
| `approval.updated`   | `Approval` (phase / decision / delivery changes)                                              | same                                                     |
| `task.upserted`      | `TaskSummary`                                                                                 | Tasks, Now, Flow                                         |
| `task.activity`      | `{ taskId, item: TaskActivity }`                                                              | task drawer, Flow inspector                              |
| `lane.upserted`      | `{ briefId \| null, agentId, block: LaneBlock }`                                              | Now › Score, Chat plan card                              |
| `handoff.created`    | `{ briefId \| null, handoff: Handoff }`                                                       | Score connectors, Flow edges, live log                   |
| `brief.upserted`     | `BriefSummary`                                                                                | Flow brief picker and header; refetch that brief's graph |
| `run.updated`        | `RunSummary`                                                                                  | Flow inspector, Watch header                             |
| `attempt.updated`    | `AttemptSummary` (5.17a-1, only with attempts on; created, closed, bounded or resumed)         | Now, Flow, Reports, Team history; notifications open the task (current) or the attempt, never a Watch URL |
| `gap.recorded`       | `{ source: string; runId: string \| null; from: string; to: string \| null; reason: string }` | Watch, Flow log                                          |
| `log.line`           | `LogLine`                                                                                     | Flow live log, Watch "What she's doing"                  |
| `watch.frame`        | `WatchFrame`                                                                                  | Watch                                                    |
| `memory.saved`       | `{ agentIds: AgentId[], text, source: Ref \| null }`                                          | Chat "Learned here", Team memory                         |

## 3. System and search

- `GET /api/system` → `SystemStatus`
  ```ts
  type SystemStatus = {
    mode: 'live' | 'fake'
    hermes: {
      version: string | null
      reachable: boolean
      apiServer: boolean
      capabilities: string[]
      servedProfiles: string[]
    }
    bridge: {
      producers: number
      lastSeenAt: string | null
      isolation: 'in_process' | 'host' | 'unknown'
    }
    compatibility: {
      fingerprint: string
      tested: boolean
      disabled: string[] /* features off by the gate */
    }
    agentIsolation: 'same_user' | 'sandboxed' | 'unknown' /* D7.1 threat-model indicator */
    degraded: string[] /* human-readable reasons */
  }
  ```
- `POST /api/session/pair` `{ token: string }` → `204` + `Set-Cookie: score_session=…` (one-time token printed by
  the server on its terminal). `GET /api/session` → `{ paired: boolean }`. `DELETE /api/session` → `204`.
- **Remote access mode** (`SCORE_REMOTE=1`, ARCHITECTURE D7.2; absent in local mode). The server denies every request that
  lacks a paired session except this exact public list: `POST /api/session/pair`, the two passkey sign-in routes (5.28), `GET /api/session` (boolean only),
  `GET /api/health` (`{ ok, contract }` only) and the built static web assets (`GET` only). HEAD, encoded aliases, previews,
  `/api/stream`, media and all other routes return `401 not_paired`; a Host not in `SCORE_PUBLIC_ORIGINS` returns `403`.
  Mutations also need an allowed `Origin` (missing or `null` is refused). Private responses carry `Cache-Control: no-store`.
  Sessions expire after 7 days idle or 30 days absolute (stream heartbeats do not renew). Revocation and expiry close that
  session's open `/api/stream` connections. Bridge routes (`/bridge/v1/*`) are served only on a separate loopback listener.
  - **HTTPS only (5.18).** Remote mode serves the app only over TLS. The browser port accepts TLS and plain HTTP together
    (the first byte of a connection decides: `0x16` is a TLS handshake). Over plain HTTP, and for every request while no
    certificate is configured (*guide-only mode*: no database, pairing, API, stream or web app is started), the server
    answers `GET`/`HEAD /setup/https` and `GET /setup/https/score-ca.crt` and nothing else: any path under `/api` gets
    `426 { error: { code: 'https_required', message } }` and every other path `308` to `/setup/https`.
    `SCORE_REMOTE_INSECURE_HTTP` no longer exists: it is ignored and the server logs that it was removed.
  - `GET /setup/https` (public, on both protocols) → static HTML, the HTTPS setup guide: why HTTPS is needed, the
    recommended `scripts/score tls` flow with per-platform steps to trust Score's certificate authority, and the option to
    bring your own certificate (`SCORE_TLS_CERT`/`SCORE_TLS_KEY`). It links to `https://<host>/` for the secure address
    (the host comes from `SCORE_PUBLIC_ORIGINS` or a well-formed `Host` header, never echoed otherwise) and shows no secrets.
  - `GET /setup/https/score-ca.crt` (public) → `application/x-x509-ca-cert`: the **public** certificate of Score's local
    CA from `$SCORE_HOME/tls/ca.crt`; `404 not_found` when `scripts/score tls` has not been run. It never serves the CA
    or server private key.
  - `GET /api/session/browsers` → `{ items: { id: uuid; label: string; address: string; createdAt: iso; lastSeenAt: iso;
expiresAt: iso; current: boolean }[] }` (`PairedBrowsersSchema`). `id` is a management id, never a credential.
  - **Pairing management needs the security password** (owner, 2026-10-08), so a compromised paired browser can't invite
    devices, keep itself alive or terminate the owner's pairings. Body `{ password }`; `409 password_not_set`,
    `403 wrong_password`, `429 too_many_attempts` (5 wrong in 15 minutes per paired browser, 20 overall; a new
    password clears the count).
    - `GET /api/session/security` → `{ passwordSet: boolean; origins: string[] }` (`origins` = `SCORE_PUBLIC_ORIGINS`, the
      choices for a pairing link; the first is the default) · `PUT /api/session/security/password`
      `{ password; current? }` → `204` (first time without `current`; afterwards `current` is required; a forgotten
      password is reset on the host with `scripts/score password`). Stored as a salted scrypt hash, 0600.
    - `POST /api/session/security/check` `{ password }` → `204` when it is the security password (5.23: lets the owner
      confirm it before using it); same errors and the same attempt limits as every password-guarded action.
    - `POST /api/session/pairing-links` `{ password; origin? }` → `{ url; expiresAt }`: the same one-time, 15-minute token the
      console prints (minting replaces any unused one). `origin` (5.29) must be one of `origins` from the security status
      (`400 bad_request` otherwise); the link uses it instead of the default, e.g. for the Tailscale address. The web page
      draws the link as a QR code (inline SVG) while it is unexpired and unused.
    - `POST /api/session/browsers/:id/renew` `{ password }` → the browser with a fresh 30-day limit and 7-day idle
      window (renewing counts as activity); that browser's cookie is re-sent on its next request.
    - `POST /api/session/browsers/:id/revoke` `{ password }` → `204` (idempotent) · `POST /api/session/browsers/revoke-others`
      `{ password }` → `{ revoked: number }` (keeps only the caller).
  - **Installable app (5.28).** `manifest.webmanifest` (`application/manifest+json`), the icons, `offline.html` and `sw.js` are
    ordinary public static assets. `sw.js` is served with `Service-Worker-Allowed: /`. The worker caches the app shell only
    (`/index.html`, `/assets/*`, the manifest and icons) and never touches `/api/*`, `/s/*`, `/bridge/*`, `/setup/*` or `/pair`
    (pairing tokens never pass through it); page loads are network-first and show `offline.html` when Score can't be reached.
  - **Passkeys (5.28).** WebAuthn credentials that sign a browser in; the session they create is a normal paired-browser
    session (same cookie, 30-day limit, 7-day idle window, revoke, renew, rate limits). Table `passkeys` (migration 0035):
    credential id, RP ID, public key, sign count, transports, label, created/last used, flagged. They need a **domain name**:
    the RP ID is the host of the browser's `Origin`, which must be one of the allowed origins; an IP address (the LAN
    address) is refused with `409 passkeys_unavailable`, and `localhost` works. Ceremonies always require user verification
    (`residentKey: 'preferred'`, ES256 and RS256, no attestation). Challenges are single-use, expire after 5 minutes, and a
    registration challenge is bound to the paired session that asked (an authentication challenge to the caller's address);
    every verification failure is `401 passkey_failed`.
    - `GET /api/session/passkeys` (paired) → `{ available: boolean; rpId: string | null; items: { id; label; createdAt: iso;
      lastUsedAt: iso | null; flagged: boolean }[] }` (`PasskeysSchema`; `available` is false on an IP address).
    - `POST /api/session/passkeys/registration-options` `{ password; label? }` (paired + security password) → WebAuthn
      creation options (JSON). `POST /api/session/passkeys` `{ response }` (paired) → `201` the new item.
    - `POST /api/session/passkeys/:id/remove` `{ password }` → `204`. Removing every passkey leaves pairing links working;
      "Terminate all other pairings" does not remove passkeys.
    - Public (remote guard) and rate limited like pairing: `POST /api/session/passkey/authentication-options` → WebAuthn request
      options (no credential list; discoverable credentials) and `POST /api/session/passkey/authentication` `{ response }` →
      `204` + `Set-Cookie: score_session=…`. A sign-count regression (once a counter is in use it must grow) refuses the
      assertion and flags the credential, which then no longer signs in until it is removed.
  - Paired browsers' cookies are re-sent at most hourly with Max-Age = the session's remaining lifetime.
- **Log viewer (5.29).** `GET /api/system/logs?level=info|warn|error&q=&limit=` (paired browsers only, in every mode; `limit`
  1 to 2000, default 500) → `{ available: boolean; items: { time: iso | null; level: 'info' | 'warn' | 'error'; message: string;
  method: string | null; url: string | null; status: number | null; durationMs: number | null }[] }` (`LogsResponseSchema`).
  Reads Score's own log file (`SCORE_LOG_FILE`, set by `scripts/score`; the rotated `<file>.1` follows the live file), newest
  first, from the last 4 MB of each. Lines are pino JSON (time, level, msg, req, res, responseTime) or plain launcher output
  (time null). `level` is a minimum (`warn` = warn and error); `q` is a case-insensitive substring of message, method or URL.
  **Every text field passes through `redact()` on the server**, so no secret leaves in a log line. `available: false` when
  `SCORE_LOG_FILE` is not set. No Hermes log files.
- **Web terminal (PLAN 7.3; schemas in `packages/contract/src/terminal.ts`).** A shell on the Score machine for the owner.
  **Off unless the server starts with `SCORE_TERMINAL=1`**: otherwise none of the routes below are registered (`404 not_found`)
  and `GET /api/session/security` reports `terminal: false` (the field is `true` when on, and also `false` if the `node-pty`
  native module failed to load, which is logged). None of the routes is public in remote mode: all need a paired session
  (so the exact public list in the remote-access item above is **unchanged**), and the WebSocket needs the ticket as well.
  **HTTPS only:** the routes exist only on the TLS listener (remote mode with a certificate); local mode never has them and
  `GET /api/session/security` reports `terminalUnavailable: string | null` with the reason ("needs HTTPS (remote mode with a
  certificate)", "node-pty not built"). Ticket minting and the upgrade check the socket is encrypted (`426 https_required`).
  **Host-issued second factor:** a ticket needs a fresh password or passkey check (≤ 60 s, consumed by the mint) **and** a
  security password set on the Score machine with `scripts/score password` (`security-password.origin` = `host <digest>`);
  a password set or changed from a browser does not unlock terminals (`403 second_factor_not_enrolled`), and passkeys count
  only while the password is host-issued.
  - `POST /api/terminal/tickets` (paired; mutation, so `X-Score-Client` and an allowed `Origin`) → `{ ticket, expiresAt }`
    (`TerminalTicketSchema`). Needs a second factor made **by this session in the last 60 s**: a correct security password
    (`POST /api/session/security/check`, or any other password-guarded route) or a passkey assertion
    (`POST /api/session/passkey/authentication` by an already paired browser now only marks the session fresh and returns
    `204` without a new cookie). `freshAuthAt` lives on the server, is used up by minting (one check, one ticket) and
    forgotten when the session ends. The ticket is 256 random bits, kept only as a hash, valid 60 s, **bound to the session and
    the request `Origin`**, single use (any redeem attempt burns it). Errors: `403 fresh_auth_required`,
    `429 too_many_terminals` (2 open), `429 too_many_attempts` (10 mints a minute per session), `403 forbidden` (missing or
    disallowed Origin).
  - `GET /api/terminal/ws?ticket=…` (WebSocket upgrade). Same Host rule as remote mode (`Host` must be the `Origin`'s host), an
    allowed `Origin` (required), the paired-session cookie **and** a valid ticket for exactly this session and origin; any
    failure is a plain HTTP error before the upgrade (`401 not_paired`, `403 forbidden`, `403 ticket_invalid`). The ticket is
    redacted from every log line. Frames: client to server **binary** = stdin (at most 64 KiB), **text** JSON
    `{ type: 'resize', cols, rows }`; server to client **binary** = stdout, **text** JSON `{ type: 'ready', id, user }` first and
    `{ type: 'exit', reason: 'exited'|'idle'|'limit'|'closed'|'revoked'|'stalled'|'stopped', code }` last.
  - `GET /api/terminal/sessions` (paired) → `{ items: { id, openedAt, lastActivityAt, address, cols, rows }[] }`;
    `DELETE /api/terminal/sessions/:id` (paired) → `204`, `404` if not open. Settings › Terminal uses them.
  - **Process.** `node-pty` spawns the account's login shell as `[shell, '-l']` (argv, no shell string) in `$HOME` with exactly
    `HOME USER LANG PATH TERM=xterm-256color SHELL`, never Score's own environment. At most 2 terminals; closed after 15 min
    without input or output, or 8 h absolute. Closing the socket, revoking or expiring the session, signing out, closing from
    Settings or stopping Score sends the process group SIGHUP, then SIGKILL after 3 s. Output is paused while the socket holds
    more than 1 MiB unsent; a client that stays stalled for 60 s is dropped. The log records open, close and kill (terminal
    id, session prefix, address, reason, duration) and never keystrokes or output.
- `GET /api/search?q=` → `{ items: { kind: 'agent'|'task'|'room'|'message'|'command'|'setting'; id: string;
label: string; hint: string | null; ref: Ref | { kind: 'route'; path: string } }[] }` (⌘K palette)

## 4. Now

### Score view

- **S** `GET /api/now?from=<iso>&to=<iso>` →
  ```ts
  { asOfSeq: number; now: string; paused: boolean /* Pause everyone is on */
    headline: { working: number; needsYou: number; text: string /* "Two agents are working. One thing needs you." */ }
    lanes: { agent: AgentSummary; blocks: LaneBlock[] }[]; handoffs: Handoff[]
    unattributed?: { blocks: LaneBlock[] }      // 5.17a-1, attempts on only: attempts with no known agent
    focusApproval: Approval | null              // the dark "X is asking" card
    thread: { roomId: string; messages: Message[] } | null   // "Latest from the room"
    madeToday: { title: string; ref: Ref; files: { path: string; added: number; removed: number }[]
                 checks: { label: string; agentId: AgentId; verdict: 'passed' | 'changes_requested' | 'unknown' }[] }[] }
  ```
  `verdict` replaced `ok` (5.17a-1): `unknown` = no exact evidence either way, drawn neutrally, never as passed. Without
  attempts a review is `passed` or `unknown` (a normal reviewer completion is not evidence of approval, so it never
  reads as a rejection). With attempts, checks also come from exact attempt evidence: a reviewer-role attempt
  (the claim event's `source_status = 'review'`) that ended `changes_requested` is `changes_requested`; one that
  completed is `passed` only when the task is done and no attempt started after it; any other end is `unknown`.
  **Attempts in Now (5.17a-1, attempts on).** Each attempt of the window is one finite block (`attempt:<kr id>`) in its
  agent's lane, sorted by `order`; copies from an earlier history of the same source are not drawn twice. A finished
  attempt ends at `endedAt`; one that stopped being observed ends at `observationEndedAt` (dashed "no longer observed"
  tail on the client, nothing counted after it). Attempts without a known agent are in `unattributed.blocks`, and
  hand-offs from or to them have `agentId: null`. An attempt of an earlier copy of the board has `taskId: null` (it
  opens its attempt detail instead). An unattributed attempt never makes an agent "working" in the headline.
- `POST /api/team/pause` / `POST /api/team/resume` → `{ paused: boolean; affectedRuns: number }`
- Composer: same as `POST /api/rooms/:roomId/messages`, with `roomId` = the current room.

### Flow view

- **S** `GET /api/briefs?status=active|recent` → `{ items: BriefSummary[] }`
  `type BriefSummary = { id; title; roomId; startedAt; startedBy: 'you' | AgentId; status: 'running'|'paused'|'done'|'failed' }`
- **S** `GET /api/briefs/:briefId/flow` →
  ```ts
  {
    asOfSeq
    brief: BriefSummary
    nodes: {
      id: string
      kind: 'brief' | 'step'
      title: string
      agentId: AgentId | null
      state: 'done' | 'working' | 'needs_you' | 'planned' | 'failed'
      subtitle: string /* "reviewer, 2 passes" */
      taskId: string | null
      layout: {
        col: number
        row: number
      } /* server hint; client may re-layout */
    }
    ;[]
    edges: {
      id: string
      from: string
      to: string
      kind: 'flow' | 'handoff' | 'review' | 'sent_back' | 'planned'
      label: string | null
    }
    ;[]
    stats: {
      runningSec: number
      steps: number
      handoffs: number
      spendUsd: number | null
      eta: string | null
      attempts?: number /* 5.17a-1, attempts on: Kanban attempts counted in runningSec; their cost is unknown */
    }
    notice: string |
      null /* the brief's agents also worked on tasks not linked to it; links stay exact */
  }
  ```
- **S** `GET /api/flow/nodes/:nodeId` → `{ node; description: string; steps: TaskStep[]; approval: Approval | null
run: RunSummary | null; model: string | null; tools: string[] | null; attempts?: AttemptSummary[]; watch: { agentId; thumbnail: string | null; front: string } | null }`
  `tools: null` = not observed (a step that only Kanban attempts worked on); `[]` = observed, none used. `attempts` (5.17a-1,
  attempts on) lists the step's attempts of the board lineage Score follows, by `order`. With any attempt in the brief
  `stats.spendUsd` is `null`: an attempt's cost is unknown, so the total would be partial.
- **S** `GET /api/briefs/:briefId/log?agent=&kind=tool|all&cursor=` → `{ items: LogLine[]; nextCursor }`
  `type LogLine = { id; at; agentId; kind: 'tool' | 'message' | 'handoff' | 'approval' | 'system'; text }`
- **H** `POST /api/briefs/:briefId/pause` / `/resume` → `BriefSummary`. Pause holds Score's queue for the brief and blocks
  its not-started tasks (`hermes kanban block`); running steps finish. Resume unblocks only what Score blocked.
- **H** `POST /api/flow/nodes/:nodeId/stop` → `{ ok: true }`: stops that node's active run (409 when nothing is running; 501 `unsupported` with a message when the active run was not started by Score, e.g. a Kanban or gateway run). A Kanban attempt is never stoppable from Score (Hermes has no stop that targets one attempt): a step whose task has an attempt that is still observed running, or a run id `kr_…`, answers the same 501 before any profile or run lookup.
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
    frames: WatchFrame[]; markers: { seq: number; at: string; kind: 'command' | 'file' | 'browser' | 'asked' }[];
    gaps: { from: string; to: string | null; reason: string }[] }
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
- `PATCH /api/rooms/:roomId` `{ name?, leadAgentId?, members? }` → `Room` (more fields below: organising, `autoSummary`)
- **S** `GET /api/rooms/:roomId` → `{ asOfSeq; room: Room; filesInPlay: string[]
learned: { text: string; savedTo: AgentId[]; at: string }[] }`
- **S** `GET /api/rooms/:roomId/messages?before=<cursor>&limit=50` → `{ asOfSeq; items: Message[]; nextCursor }`
- **H** `DELETE /api/rooms/:roomId/messages/:messageId` → `204`. Removes the message from Score for everyone (soft delete:
  `messages.deleted_at`); it is left out of room reads, unread counts, the Now thread, the context handed to agents and
  exports. Runs, Reports and the agents' Hermes session history are untouched, so an agent may still remember it. `409
  conflict` while the message is still streaming; `404` for an unknown room or message; idempotent (deleting a deleted
  message is `204`). Emits `message.deleted`.
- **H** `POST /api/rooms/:roomId/messages/:messageId/retry` → `202 { messageId }` (the new streaming placeholder
  reply). `messageId` is a finished agent reply that answered a person's message: the same agent gets the same input
  again through the normal dispatch path (pause, approvals, attachments and the one-turn-per-agent queue apply). The
  original reply stays. `404` unknown; `409 conflict` when the message is not a retryable reply (no parent turn, parent
  deleted or not from the person), when that agent is still answering that message, or while the team, the agent or the
  brief is paused. Idempotent per `Idempotency-Key`.
- **H** `POST /api/rooms/:roomId/messages/:messageId/stop` → `{ ok: true }` (PLAN 5.25): stops the Score-started run that is
  writing that streaming agent reply; the reply ends with "This run was stopped." `404` unknown; `409 conflict` when the
  message is not a reply being written by a running run (finished, or still queued).
- **S** `GET /api/rooms/:roomId/messages/:messageId/rewind-plan` → `RewindPlan` `{ hiddenCount; agents: { agentId; turns;
  cannot: RewindSkipReason | null }[]; blocked: string | null }` (PLAN 5.33): what a rewind of the person's own message
  would do, for the confirmation. Nothing changes. `turns` is the number of Hermes user turns of that agent's room session
  (`score-<room>-<agent>`) that started at or after the message and are still in Hermes; `blocked` says why a rewind can't
  start now (an agent is answering or has queued work, or the room's work is paused with pending holds). `404`/`400` as for
  `edits`.
- **H** `POST /api/rooms/:roomId/messages/:messageId/rewind` `{ mode: 'edit' | 'delete'; scoreOnly?: boolean }` →
  `{ version: RoomVersion; rewound: { agentId; turnsUndone }[]; skipped: { agentId; reason: RewindSkipReason }[] }`
  (PLAN 5.33). The message is the person's own, finished, in this room. The message and **every message after it in the
  room** become a *previous version* (`messages.deleted_at` plus `version_id`: left out of normal reads exactly like a
  deleted message; `message.deleted` for each, then `room.version.created`). Unless `scoreOnly`, every agent whose Hermes
  session for this room has user turns at or after the message is **rewound** to just before it, through the bridge
  (`rewind` command, §11). Score counts the turns from its own records (`message_runs`, not already rewound) and checks
  them against Hermes's own history read-only; the lineage of compressed sessions is followed and a rewind across a
  compression boundary is not attempted. Nothing is hidden unless every needed rewind succeeded; otherwise `409
  rewind_incomplete` with `details: { skipped: { agentId; reason }[]; rewound: … }` and the person may repeat the request
  with `scoreOnly: true` (hide in Score only; `skipped` then lists every agent with `score_only`). `409 conflict` while an
  agent is answering, has queued work, or the room is paused with pending holds. Long-term memory (MEMORY.md, skills,
  Knowledge notes) is **not** rewound. Idempotent per message: repeating it returns the stored result and never rewinds
  twice. For `mode: 'edit'` the correction is then posted through the normal `POST …/messages` with `edits`, which links
  it (`RoomVersion.replacedBy`, original `editedBy`) instead of hiding again. Deleting an agent reply stays the Score-only
  `DELETE`.
- **S** `GET /api/rooms/:roomId/versions` → `{ asOfSeq; items: RoomVersion[] }` (newest first); **S** `GET
  /api/rooms/:roomId/versions/:anchorId` → `{ version: RoomVersion; items: Message[] }` (the hidden messages, anchor
  first, oldest to newest; shown read-only). `RoomVersion` `{ id; roomId; anchorId; anchorCreatedAt; mode; replacedBy |
  null; number; count; hiddenCount; rewound; skipped; createdAt }`: `number` of `count` is the position in a chain of
  edits (the correction itself was edited again). `404` unknown room or anchor.
- **S** `GET /api/agents/:agentId/context` → `AgentContext` `{ model: string | null; tokens: { input; output } | null;
  costUsd: number | null; contextLength: number | null }` (PLAN 5.25): usage of the agent's latest finished or running run
  with usage and the model's context window when Hermes's model options carry one (else `null`). `404` unknown agent.
- **S** `GET /api/agents/:agentId/sessions/:sessionId/context` → `SessionContext` + `asOfSeq` (a stream-query snapshot) `{ window: number | null; used: number | null;
  measuredAt: string | null; model: string | null; source: ReadingSource | null; parts: { kind; label; tokens }[] | null;
  autoCompactAt: number | null; compactions: number }` (PLAN 5.36): what the context meter and its popover show for one room
  session. With the plugin's `context_breakdown` answer, `parts` lists what uses the window (Hermes's categories: system prompt,
  tool definitions, rules, skills, MCP tools, subagent definitions, memory, conversation messages; compressed summaries and
  files are inside the conversation and are not separated) and `used` is Hermes's own figure. When the plugin can't answer
  (old plugin, no running gateway, coding agent, empty session) the response falls back to the totals of `GET
  /api/agents/:agentId/context` with `parts: null`. Cached up to 30 s per session; the cache is dropped when a run of that agent
  in that room finishes and after a compaction. `404` as for compact.
- **H** `POST /api/agents/:agentId/sessions/:sessionId/compact` `{ keepRecent?: int 1-20 }` → `202 { commandId }` (PLAN 5.36;
  schemas in `packages/contract/src/compaction.ts`). Asks Hermes to compact (summarise the older turns of) one of the agent's
  room sessions (`score-<roomId>-<agentId>`, which in an imported room that continues a Hermes session stands for that session;
  the tip of its compression lineage is compacted). The API server ignores `/compress`, so Score asks the agent's gateway through the bridge (`compact` command,
  §11). The request returns at once; the answer is the stream event `session.compacted`
  `{ commandId; agentId; sessionId; roomId: string | null; status: 'compacted' | 'nothing' | 'failed'; reason: CompactFailureReason
  | null; keepRecent: number | null; before: { messages; tokens } | null; after: { messages; tokens } | null }`
  (`reason`: `bridge_unavailable`, `no_answer`, `session_busy`, `lock_held`, `no_session`, `compact_failed`; `tokens` are Hermes's
  rough request estimates; `nothing` = too short to compact). Refusals, synchronous: `404` unknown agent or a session that
  is not one of this agent's room sessions; `409 unsupported` for a coding agent; `409 session_busy` while a message run of
  that agent in that room is `pending` or `active` (Stop first) or the room is being rewound; `409
  orchestration_owned` for a session in a room an orchestration or workflow run owns (owned or draining);
  `409 conflict` when a compaction of that session is already in flight. Compacting changes the agent's Hermes session (a
  compression continuation); the context meter reads the next run's usage. Idempotent per `Idempotency-Key`.
- `POST /api/rooms/:roomId/messages`

  ```ts
  req: { text: string; to?: AgentId[] /* explicit "To" chips; @mentions in text are merged */
         planFirst?: boolean; model?: string /* one-shot /model */; attachments?: ({ mediaId: string; name?: string } | { workspace: { agentId: AgentId; path: string; root?: string /* root the file was picked from: a changed root is 409 workspace_changed */ } })[] /* ≤ 10 */
         edits?: MessageId /* edit and resend: the sender's own earlier message in this room */ }
  res: { message: Message; routedTo: AgentId[]; command: CommandResult | null; notices?: string[] }
  ```

  `edits` (PLAN 5.24) must name a finished, undeleted message of the person in the same room that has not been edited
  yet: `404` unknown (or already replaced) message, `400` not the person's own, streaming or in another room, `409`
  already edited or an agent is still answering it. The new message is an ordinary turn (it carries `edits`); the
  original **is replaced** (owner 2026-10-09): it gets `editedBy` (`message.updated`) and is removed from Score together
  with every reply in its chain (`message.deleted` for each, as Delete). Agents' Hermes histories keep the old turn
  unless the session was rewound first (`…/rewind`, PLAN 5.33). A post with `edits` for a message that was not rewound
  hides it and everything after it in Score only (a version with `scoreOnly`); one that was rewound is just linked. The web composer pre-fills text, recipients and attachments from the
  original.

  Text starting with a slash command is parsed server-side:

  | Command     | Syntax                                                 | Effect                             | `CommandResult`                               |
  | ----------- | ------------------------------------------------------ | ---------------------------------- | --------------------------------------------- |
  | `/assign`   | `/assign @agent <title> [-- body]`                     | creates a Kanban task              | `{ kind: 'assign', taskId, taskKey }`         |
  | `/routine`  | `/routine @agent <schedule> <prompt>`                  | creates a cron job                 | `{ kind: 'routine', routineId }`              |
  | `/remember` | `/remember [@agent…] <fact>`                           | writes agent memory                | `{ kind: 'remember', agentIds }`              |
  | `/skill`    | `/skill @agent <name>` (use) · `/skill install <name>` | loads or installs a skill          | `{ kind: 'skill', name, installed: boolean }` |
  | `/model`    | `/model <model> <message…>`                            | runs this message on another model (a name that is one of the agent's aliases also carries the alias's provider to Hermes) | `{ kind: 'model', model }`                    |

  `/remember` and `/skill` are parsed but not implemented yet: they answer `501 not_implemented` and are left out of
  the slash menu. Use the agent's Memory and Skills tabs instead.

  The web composer also handles three commands itself and never posts them (PLAN 5.25): `/usage` (shows
  `GET /api/agents/:agentId/context` as a local card), `/model <model>` with no message (calls
  `PUT /api/agents/:agentId/model`) and `/compress` (PLAN 5.36: after a confirmation it calls
  `POST /api/agents/:agentId/sessions/:sessionId/compact` for the room's session of that agent and shows the before/after
  token counts from `session.compacted`; the context meter's **Compact** button does the same). They
  act on the first "To" chip, else the agent that answered last, else the room lead.

- `GET /api/commands` → `{ items: { name: string; usage: string; description: string }[] }` (slash menu: only the
  supported commands)
- **H** `POST /api/media` (multipart, one part named `file`) → `201 { mediaId: string; name: string; size: number;
contentType: string }`. Types come from the bytes: png, jpeg, gif, webp, PDF, DOCX and XLSX (told apart by their ZIP
  entries), and plain UTF-8 text, where the file name's extension (or the declared type) picks `text/plain`,
  `text/markdown`, `text/csv`, `application/json` or `text/html`. `400` empty or malformed, `413` over 8 MB for an image
  or 25 MiB for anything else, `415` unsupported or contradicting type, `507 media_quota_exceeded`. `GET /api/media/:mediaId`
  serves by kind: images and text (HTML as `text/plain`, never rendered) inline under `default-src 'none'; sandbox`; PDF,
  DOCX/XLSX, and any file with `?download=1[&name=]`, as `attachment` (octet-stream, `nosniff`, sandbox CSP; a PDF is never rendered
  from Score's origin, because Chrome's viewer cannot run under a sandbox CSP). Messages reference uploads with an `image` part, or a `document` part for everything else, plus
  `workspace` parts for workspace files (`{ workspace: { agentId, path } }`, checked against that agent's workspace, no
  copy); at most 10 attachments per message. What each addressed agent receives (5.30): text files (TXT, MD, CSV, JSON,
  HTML) inline in the run input, fenced, redacted, up to 64 KB each and 200 KB per message (truncated with a note); PDF,
  DOCX and XLSX saved into that agent's workspace as `attachments/<yyyy-mm-dd>/<safe name>` (never overwriting; if the
  workspace is unavailable only the name is sent and `notices` says why) with the path named in the run input;
  workspace references are named by path. Images as below. Images on a person's message are sent to each addressed agent's run (the person's
  own message only, never hand-offs between agents): total raw size up to 6 MB per message; images that do not fit
  or are no longer stored are skipped and the run's text gets a short note saying so.

### Conversations: organise, search, export (PLAN 5.26; schemas in `packages/contract/src/conversations.ts`)

- `Room` also carries `pinned`, `archived` (booleans), `projectId: string | null`, `tags: string[]` (explicit tags, else the
  `#tag` words after the first word of the name) and `importedFrom: RoomImport | null` (§ Outside sessions). Room names may
  end in tag words: `#launch #q4 #urgent`. Score-side only; `room.upserted` carries them.
- `GET /api/rooms` also returns `projects: RoomProject[]` (`{ id; name; color: '#RRGGBB' }`, by name).
- `PATCH /api/rooms/:roomId` also takes `pinned?`, `archived?`, `projectId?: string | null` (`404` for an unknown project),
  `tags?: string[] | null` (`null` = follow the name's tags again; at most 12, `^[a-z0-9][a-z0-9-]{0,31}$`).
- **H** `POST /api/room-projects` `{ name; color }` → `RoomProject` (`409 conflict` on a name already used, case-insensitive) ·
  **H** `PATCH /api/room-projects/:id` `{ name?; color? }` → `RoomProject` · **H** `DELETE /api/room-projects/:id` → `204`
  (its rooms leave the project). Stream: `room-project.upserted` (the project) and `room-project.deleted` (`{ id }`); a
  deleted project also emits `room.upserted` for each room that was in it.
- **Rename** (PLAN 5.36): `PATCH /api/rooms/:roomId { name }` is the rename (the same name rules as creating a room: `#`-prefixed
  slug, then optional `#tag` words; `409 conflict` for a name another room uses). Renaming is an organising action like
  pinning and tags: it is allowed while an orchestration or workflow run owns the room (it does not touch the run's
  records). The room header (click the name) and the room's ⋯ menu start an inline edit.
- **H** `DELETE /api/rooms/:roomId` `{ confirm: string }` → `204` (PLAN 5.36). `confirm` must equal the room's current name
  (`400 bad_request` otherwise). Score-side only: the room, its messages (with their attachment references; media files no other
  message uses are released to the normal media cleanup), message runs, versions, summaries, shares, reads, sessions,
  rewind holds, the briefs started in it with their task links (the Kanban tasks stay in Hermes), plan starts, coding
  sessions and the room links of tasks are removed in one transaction. Runs, Reports, Watch history and the agents' Hermes sessions are
  **not** touched (the dialog says so). Refusals: `404` unknown room; `409 conflict` for a direct room (an agent's home);
  `409 room_busy` while any message run in the room is `pending` or `active`, or while it is being rewound (Stop
  first); `409 orchestration_owned` while an orchestration or workflow run owns it (owned or draining). A room whose run is
  finished and released may be deleted: the run's records are pruned in the same transaction with the executor's
  prune path (the journal keeps its tombstones; the single `pruned` history row stays), then the room. Emits `room.deleted
  { id }` after the transaction (the briefs simply disappear from the next read). The
  web asks for the typed name, offers the room export first, and then returns to Chat home.
  `GET /api/rooms/:roomId/delete-plan` (**S**) → `RoomDeletePlan` `{ name; messages; files; runs; briefs; blocked: 'room_busy' |
  'orchestration_owned' | 'direct' | null }`, the counts the dialog lists (`files` = distinct attachments, `runs` = message runs
  plus an orchestration run's records).
- `GET /api/search/messages?q=&roomId?&limit=` (limit ≤ 50, default 20) → `{ items: { messageId; roomId; roomName;
  author; createdAt; snippet }[] }`: FTS5 over the text parts of finished, undeleted messages (a streaming reply is
  indexed once it completes); the query is tokenised into quoted terms (no FTS syntax from the user, the last word is a
  prefix); `[[`/`]]` in `snippet` mark matches (redacted). Used by the ⌘K palette ("Messages") and the Chat search box;
  the web opens a hit at `/chat/:roomId?message=:messageId` and scrolls to it.
- `GET /api/rooms/:roomId/export.md` and `.json` → a download (`Content-Disposition: attachment`): header (room, members,
  exported at) and the room's finished, undeleted messages with author, time, text (redacted), `file` parts as
  path and counts, `image` parts as media ids (no bytes). Tool, thinking, plan, review and approval parts are left out.

### Room summaries (PLAN 7.4a; schemas in `packages/contract/src/conversations.ts`)

- `Room.autoSummary: { enabled: boolean; thresholdTokens: number }` (default `{ enabled: false, thresholdTokens: 12000 }`,
  threshold 2,000-200,000), set with `PATCH /api/rooms/:roomId { autoSummary }`. Opt-in per room, because a summary costs
  model tokens. Tokens are an **estimate** (characters / 4) of the room's visible text that no usable summary covers; the
  threshold is about what Score would send, not Hermes's own session (Score never edits Hermes sessions for this).
- `MessagePart { kind: 'summary'; coversUntil; text; stale?; edited? }`: `coversUntil` is the newest message covered; the
  message's author is the agent that wrote it (the room's lead); the part is the **only** part of that message (no tool
  cards, hand-offs or plan), and `text` is plain text/Markdown with HTML tags and comments removed. Exports, search and
  share links include `text` parts only, so a summary is left out of them.
- The summary run is a normal run of the lead agent (shows in Flow/Reports), queued like any turn: not started while the team
  or the lead is paused or the room is being rewound, and one at a time per room. Its input is the fixed instruction plus the
  earlier summary (if still usable) and the newer finished messages. A new summary replaces (soft-deletes) the older one.
  Auto trigger: after a message completes in an opted-in room whose uncovered estimate exceeds the threshold; after a failed
  summary it waits for the next message from the person.
- Context: with a usable summary the "Room context" of a turn is the summary (labelled with its author) plus the messages
  after `coversUntil` (up to 40, 16 KiB); without one, the last 10 messages as before.
- **Stale**: when a message the summary covers is deleted, edited or rewound after the summary was written, the part gets
  `stale: true` (`message.updated` with `parts`) and the summary is **no longer used as context** until it is regenerated or
  edited by the person. Rewinding to a covered message hides the summary message itself with the rest of that version.
- **H** `POST /api/rooms/:roomId/summary` `{}` → `202 { messageId }`: (re)generate now. `409 conflict` when the room has no
  lead, the team/lead is paused, the room is being rewound, a summary is already being written, or there is nothing new to
  summarise.
- **H** `PATCH /api/rooms/:roomId/summary` `{ text }` (1-16,384 chars) → `{ messageId, parts }`: the person's own wording; sets
  `edited: true` and clears `stale`. `404` when the room has no summary. Emits `message.updated`.
- **H** `DELETE /api/rooms/:roomId/summary` → `204` (soft delete of the current summary message; `404` when none). Turns then
  use the plain recent window again.

### Share links (PLAN 5.26; security design by the lead, 2026-10-09)

A share is a **frozen snapshot** of one room, readable by anyone who has the link and can reach Score (LAN or Tailscale; the
create dialog says so). Nothing live is exposed.

- **H** `POST /api/rooms/:roomId/shares` `{ password; expiresInDays?: 1..30 (default 7); includeImages?: false }` →
  `{ id; url; expiresAt }`. `password` is the security password, with the same check, limits and errors as pairing
  management (`409 password_not_set`, `403 wrong_password`, `429 too_many_attempts`). `url` = `<public origin>/s/<token>`.
  No `Idempotency-Key` receipt (the body holds the password; a replay would mint a second token).
- Snapshot content: the room's finished, undeleted messages as author name, time and the **text parts only** (Markdown
  source), each through `redact()`; with `includeImages` the media ids of `image` parts are copied into the share's own list.
  No tool, thinking, file-path, plan, review or approval parts, no room settings, member ids, workspace paths or profile
  data. The room's later edits and deletions do not change it. At most the latest 2000 messages.
- Token: 32 random bytes (base64url, 43 chars). Only its SHA-256 is stored (`room_shares.token_hash`); the token is shown once.
- `GET /api/shares` → `{ items: ShareSummary[] }` (`{ id; roomId; roomName; createdAt; expiresAt; views; includeImages;
  status: 'active' | 'expired'; roomChanged }`, newest first; `roomChanged` = a message of the room was deleted or rewound after the
  snapshot (the link still shows the old text); revoked shares are gone) · `GET /api/rooms/:roomId/shares` → the same, active
  ones of that room (Chat › room menu › Share…, Settings › Shares lists all).
- **H** `DELETE /api/shares/:id` → `204` (no password needed; idempotent; `404` unknown id). Revoking withdraws the link at once
  and drops the stored snapshot.
- **`GET /s/:token`, the only unauthenticated route this task adds** (it is public in remote mode too, GET only):
  hash lookup (constant-time compare), then a static HTML page rendered on the server: text escaped, Markdown rendered
  without raw HTML (links only to http(s)/mailto, images shown as their alt text), no JavaScript. Headers:
  `Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`, `X-Robots-Tag: noindex`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
  An unknown, malformed, expired or revoked token gets the **same** `404` HTML page. Rate limit: 30 requests per minute per
  IP address (every `/s/` request counts, known token or not), then `429` (static page). Each successful page view adds to
  `views`. Plain-HTTP requests get the HTTPS guide like everything else (5.18).
- `GET /s/:token/media/:n` → the n-th image (0-based) of that share's own list, only when the share was made with
  `includeImages`; anything else is the same `404` page. Same headers and rate limit.

### Outside sessions (PLAN 5.26)

Hermes sessions that Score did not start (Telegram, CLI, Discord, …), read through the adapter from each profile's `state.db`
(opened read-only; Score never writes Hermes SQLite). Conversations only: cron, kanban, subagent and delegate sessions,
Score's own runs (`score-<room>-<agent>`), compression children and empty sessions are left out.

- `GET /api/outside-sessions` → `{ items: OutsideSession[]; unavailable: AgentId[] }` (`{ id; agentId; source; sourceLabel;
  title; startedAt; messageCount; busy; roomId }`, newest first, at most 200 per agent). `title` = the session title, else
  the first user message (redacted, cut to 120 characters). `busy` = not ended and active within the last 5 minutes.
  `roomId` = the Score room made from it, if imported. `unavailable` = profiles whose database is missing or has a changed
  schema.
- **H** `POST /api/outside-sessions/import` `{ agentId; sessionId }` → `{ roomId; imported }`: a new room (name
  `#<source>-<title> #imported #<source>`, lead and only member the agent, `importedFrom` set) holding read-only copies of
  the session's user and assistant text (redacted, original times, at most the first 1000 messages, ids start with
  `import:`; no stream events, nothing unread). Importing the same session again returns the same room with `imported: 0`.
  `404` for an unknown agent or session.
- **H** `POST /api/rooms/:roomId/continue-session` → `{ mode: 'same_session' | 'new_session' }`. `409 session_busy` while the
  session is `busy`; `409 conflict` for a room that was not imported; `404` when the session is gone. `same_session`: the
  gateway's run API takes the Hermes `session_id` (and loads its history), so the agent's new turns from this room run in the
  imported session. `new_session` (a gateway without the run API): turns use the room's own session and the first one carries
  a short recap of the imported conversation. `Room.importedFrom.continued` shows the outcome (event `room.upserted`).
  Calling it again re-checks and updates the mode.

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
- **S** `GET /api/tasks/:taskId` → `TaskDetail`. With attempts on (5.17a-1) `TaskDetail.runIds` holds no numeric Kanban ids any more: a legacy
  numeric link maps to its attempt's `kr_` id only with affirmative proof (a saved "claimed" activity item with the attempt's frozen start
  second and claim profile); every other legacy link is reported in `unresolvedRunLinks: { legacyId; reason }[]` ("an earlier attempt,
  details not kept"; `not_yet_resolved` while the upgrade has not run). Responses of `POST /api/tasks` and `PATCH /api/tasks/:taskId` and
  stored idempotency receipts of task routes are rewritten the same way; a receipt is never deleted, so a replay still cannot run the
  mutation again. Associations of a task (brief link, room link, pause holds, review edges, Kanban denials) are qualified by the board
  lineage (`history_id`); rows Score cannot tie to the lineage it follows are inert: shown, never routed, parked or released, and a pause
  release skips and reports them. An unqualified denial never authorizes task actions.
- **S** `GET /api/attempts/:attemptId` → `AttemptDetail` (5.17a-1; `404 not_found` when attempts are off or the id is unknown). Also for
  an attempt of an earlier copy of the board (read-only, "from an earlier copy of the board").
- `POST /api/tasks` `{ title; body?; assignee?: AgentId; reviewer?: AgentId; roomId?; dependsOn?: string[]; steps?: string[] }` → `TaskDetail`
  `reviewer` on create and on `PATCH` answers 501 `not_implemented` (Hermes names a reviewer only when review is requested); `roomId` is kept by Score, must name an existing room (else 400) and is shown on `TaskDetail.roomId`.
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
- **H** `POST /api/agents/operations/:opId/confirm` `{ step }` → `AgentOperation`: when Score lost track of a step
  (`confirmable`: it was interrupted, not refused), the person checks it on the Hermes machine and confirms it finished;
  Score marks it done and continues. Score still checks what it can see (a created profile must exist, a deleted one
  must be gone) and never confirms a recorded failure. `step` must be the interrupted step; otherwise `409`.

- **H** `POST /api/agents/imports` (body: the archive, `Content-Type: application/octet-stream`, ≤ 200 MiB) → `201
  ImportInspection`. Score stores the upload privately (`$SCORE_HOME/profile-imports/<uploadId>.tar.gz`, directory 0700,
  file 0600) and inspects it by streaming, never extracting it: one top-level directory; only regular files and
  directories (links, devices and special files are refused, as Hermes does); no absolute, drive-letter or `..`
  paths; at most 50,000 entries, 2 GiB unpacked and a 200x expansion ratio. A refused archive is `400 bad_request` with the
  reason and is not kept. `ImportInspection` = `{ uploadId; sizeBytes; archiveRoot; suggestedId: string|null; description;
  model; configVersion; skills: string[]; plugins: string[]; memoryBytes; fileCount; totalBytes; credentialFiles: string[];
  hasBridge; warnings: string[] }`: names and counts only, never file contents (credential files are listed by path and
  never read). Uploads nobody imports are dropped after 24 hours.
- **H** `DELETE /api/agents/imports/:uploadId` → `204`: discards the upload (the preview was cancelled).
- **H** `POST /api/agents/import` `{ uploadId; id; name; role; style; confirmCredentials? }` → `202 AgentOperation`
  (`kind: 'import'`). The archive is inspected again; credential files need `confirmCredentials: true` (else `400`).
  Hermes never overwrites a profile, so an existing id (or `default`, or a retired name) is `409`: there is no replace;
  delete the agent first (which keeps a private export). Steps: `import_profile` (`hermes profile import <archive> --name
  <id>`, argv only; Hermes extracts to its own staging directory, refuses unsafe members and drops the exporting
  profile's runtime directories and role), `describe_profile` (the role), `preserve_key`, `configure_key`, `permissions`,
  `install_bridge` (pinned, `--force` over a bridge that came in the archive), `enable_bridge`, `verify_ready`. The model
  is the archive's own and is not changed. `import_profile` is neither retried nor adopted; if it fails nothing is
  installed by Score and the upload is removed; once it succeeds the upload is removed. Hermes also writes a launcher script
  for the new profile into `~/.local/bin` (no option to skip it).

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
`AgentOperation` is `{ id; kind: 'create'|'delete'|'import'; targetName; incarnationId; requestHash;
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
    personality: { excerpt: string; source: 'SOUL.md' }
    reportsTo: AgentId | null
    worksIn: string | null
    rulesFile: 'AGENTS.md' | null
    model: {
      id: string
      label: string
      via: string /* "Codex sign-in" */
      fallback: string | null
    } | null /* unreadable */
    skills: { name: string; enabled: boolean }[]
    memory: { id: string; text: string; source: string; at: string }[] // latest few
    tools: { id: string; label: string; kind: 'builtin' | 'mcp'; enabled: boolean }[]
    helpersMax: number | null
    routines: RoutineSummary[]
    channels: { platform: string; label: string; connected: boolean }[]
    permissions: {
      id: string
      label: string
      level: 'allowed' | 'asks' | 'never'
      inherited: boolean
    }[]
  }
  type RoutineSummary = {
    id
    title
    schedule: string /* "1h" */
    description
    lastRunAt: string | null
    enabled: boolean
  }
  ```
- `GET /api/agents/:agentId/files/:file` (`file` ∈ `SOUL.md|AGENTS.md`) → `{ content: string; etag: string }`
- `POST /api/agents/:agentId/files/:file/preview` `{ content }` → `{ diff: string }`
- **H** `PUT /api/agents/:agentId/files/:file` `{ content; etag }` → `{ etag }` (409 `conflict` on etag mismatch, with
  `details: { etag /* current */; diff /* current → submitted */ }`)
- `PUT /api/agents/:agentId/model` `{ model: string; provider?: string }` → `AgentDetail`. A `model` without `provider` that
  names one of the agent's aliases (case-insensitive) is replaced by the alias's model and provider.
- `AgentDetail.model.fallback` is the agent's `fallback_providers` chain as text (`"model-a, then model-b"`), `null` when none.
- **H** `GET|PUT /api/agents/:agentId/model-settings` (5.31, `packages/contract/src/model-settings.ts`) →
  `ModelSettings` `{ fallbacks: { provider; model }[] /* ordered chain, Hermes `fallback_providers`, any length */;
  fallbacksEditable: boolean /* false: an entry has a custom endpoint or key; shown, never rewritten (409) */;
  aliases: { name; model; provider: string | null; editable }[] /* Hermes `model_aliases`, per profile */;
  speech: { stt: { provider; model }; tts: { provider; model; voice } } }`. The PUT body is `ModelSettingsUpdate`
  `{ fallbacks?; aliases? /* the full list of editable aliases wanted */; speech?: { stt?: { provider?; model? };
  tts?: { provider?; model?; voice? } } }`, strict. Only keys whose value differs from what Hermes holds are written
  (`hermes -p <profile> config set …`, `config unset model_aliases.<name>` for a removed alias), and the answer is built from
  what was written, with no re-read. Speech provider ids and which of model/voice each has are `STT_PROVIDERS` /
  `TTS_PROVIDERS` in the contract package. `409 conflict` for a non-editable chain/alias, a model or voice the chosen
  provider doesn't have, or a Hermes refusal; `502 hermes_unavailable` when the settings can't be read.
- `GET /api/agents/:agentId/skills` → `SkillsResponse` `{ items: AgentDetail['skills'] }` · `POST …/skills` `{ name }`
  (install) → `SkillsResponse` · `PATCH …/skills/:name` `{ enabled }` → `AgentDetail['skills'][number]` ·
  `GET /api/skills/hub?q=` → `SkillHubResponse` `{ items: { name; identifier; source; trust; description }[] }`
- `GET /api/agents/:agentId/todos` → `AgentTodos` = `{ todos: { id; content; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; parent?: string }[]; revision: number; updatedAt: string } | null`.
  The agent's Hermes todo list (the `todo_list` tool keeps it in memory but every call is also a tool result in `state.db`; the
  newest `{ todos, revision, summary }` result wins, read-only). `null` when the agent never wrote one or its database is
  missing; malformed items are dropped. Shown as the Todo card on Team › agent › Overview and on Now for working agents.
- `GET /api/agents/:agentId/memory?q=&cursor=` → `MemoryPage` `{ items: AgentDetail['memory']; nextCursor: string | null }` ·
  `POST …/memory` `{ text }` · `DELETE …/memory/:id`
  `MemoryPage.writable: false` (live Hermes has no per-entry memory command) means both writes answer 501 and clients hide the controls; absent = writable.
- `PATCH /api/agents/:agentId/tools/:toolId` `{ enabled }` → `AgentDetail['tools'][number]`
- `GET /api/agents/:agentId/routines` → `{ items: RoutineSummary[] }` · `POST …/routines` `{ title; schedule; prompt }` →
  `RoutineSummary` · `PATCH /api/routines/:id` `{ enabled?; schedule?; prompt? }` → `RoutineSummary` ·
  `DELETE /api/routines/:id` → `{ id }` · `POST /api/routines/:id/run` → `{ id; queued: true }` (`409 paused` while the team or that agent is paused; runs on the scheduler's next
  tick). Routine ids are `<profile>:<jobId>`. Hermes rejecting a schedule or prompt → `409 conflict` (CLI output stays
  private).
- **H** `PATCH /api/agents/:agentId/permissions/:permId` `{ level }` → the permission row. Stricter only: take back a
  Go-ahead (`asks`) or add a Never (`permId = never:<glob>`, `level: never`); anything looser is `400 not_stricter`.
- **H** `DELETE /api/agents/:agentId/permissions/:permId` → `{ items: AgentDetail['permissions'] }`. Removes this agent's
  own override (a taken-back Go-ahead, or an agent-only Never `never:<glob>`) and re-applies the team baseline to the
  profile through the verified write loop, so the agent is never looser than the team. A rule that belongs to the team
  is `400 not_an_override`; an unknown override `404 not_found`; Hermes refusing the write `409 conflict` (the override
  is kept).
- `GET /api/agents/:agentId/channels` → `AgentChannelsResponse` `{ items: { platform; label; status: 'connected' | 'disconnected'; detail: string | null; connectCommand: string }[] }`.
  Read-only gateway state for this agent's profile (secret-free); `connectCommand` is e.g. `hermes -p builder gateway setup`,
  shown for the person to run in their own terminal.
- `GET /api/agents/:agentId/history?q=&outcome=&cursor=` → `AgentHistoryPage` `{ items: { runId; title; origin; outcome:
'completed' | 'failed' | 'stopped' | 'interrupted' | 'waiting' | 'running' | 'unknown'; startedAt; durationSec: number | null; model: string | null;
costUsd: number | null; task: { id; title } | null; brief: { id; title } | null; replaySeq: number | null; attempt?: AttemptSummary }[]; nextCursor }`.
  Score's own runs for the agent (all origins), newest first, 50 per page; the cursor is an offset. `outcome` filters,
  `q` matches task/brief title and model. `stopped` is a cancelled run; `interrupted` is a reclaimed attempt (not proof the
  worker stopped); `unknown` is any status Score does not recognise (never shown as running). Replay opens `/now/watch/:agentId?from=<replaySeq>`.
  With attempts on (5.17a-1) the agent's Kanban attempts are merged in (`runId` = the `kr_` id, `origin: 'kanban'`, `attempt` set, `replaySeq: null`):
  a normal finish (completed, review handoff, changes requested) is `completed`, a failure `failed`, a blocked, unknown or no-longer-observed end
  `unknown`. `task`/`brief` are null for an attempt of an earlier copy of the board.

### Coding agents (PLAN 7.2; schemas in `packages/contract/src/coding.ts`; design docs/briefs/7.2-coding-agents.md)

Claude Code and Codex CLI (OpenCode is listed as "not supported yet") join the team next to Hermes agents. A coding agent is
an `AgentSummary`/`AgentDetail` like any other with `runtime` set, so rooms, @mentions, hand-offs, Stop, Now, Flow, Watch and
Reports need no new paths. It takes **room work only**: a Kanban task whose `assignee`/`reviewer` is a coding agent is `422
unsupported`. Hermes-profile endpoints for an agent id that is a coding agent (`/api/agents/:id/skills`, `/memory`, `/files/…`, `/model`,
`/routines`, …) answer `409 unsupported`. Rewind is not available for them: a room rewind hides the messages in Score and drops that
room's CLI session (`skipped: no_session`).

- `GET /api/coding-agents/runtimes` → `{ items: CodingRuntimeInfo[] }`: `{ runtime: 'claude-code'|'codex'|'opencode'; label; state:
  'ready'|'not_installed'|'not_supported'|'untested_version'; version: string|null; testedVersions: string[]; quota: string; message:
  string|null }`. Read with `<cli> --version` only (never a prompt). `untested_version` = installed, but not one of the tested versions.
- `GET /api/coding-agents` → `{ items: CodingAgent[] }`: `{ id; name; role; runtime; workspace; permission: 'read-only'|'workspace-write'|'full';
  model: string|null; style; quota; cli: { state; version; testedVersions; confirmed: boolean }; createdAt }`.
- **H** `POST /api/coding-agents` `{ id; name; role?; runtime; workspace?; permission?; model?; style; password?; acknowledgeReads? }` → `201 CodingAgent`. A Codex agent needs `acknowledgeReads: true` (`400 acknowledgement_required`): Codex can read every file the owner's user can (live-checked 2026-10-10).
  `id` is a profile-style name (`^[a-z0-9][a-z0-9_-]{0,63}$`), unique among all agents (`409 conflict`). `workspace` defaults to
  `~/score-workspaces/<id>` (created) and follows the Workspace folder rules (no home folder, `~/.hermes`, `~/.score`, `~/.ssh`;
  `422 workspace_unavailable`). A CLI that is not installed/supported is `422 cli_not_installed`. `permission: 'full'` needs
  `password` (the security password; `409 password_not_set`, `403 wrong_password`, `429`).
- **H** `PATCH /api/coding-agents/:id` `{ name?; role?; permission?; model?: string|null; workspace?; password? }` → `CodingAgent`. Raising to
  `full` needs the password; lowering never does.
- **H** `POST /api/coding-agents/:id/confirm-version` `{ version }` → `CodingAgent`: lets an `untested_version` CLI run for this agent. `version`
  must equal the version Score reads right now (`409 conflict` otherwise).
- **H** `DELETE /api/coding-agents/:id` → `204` (`409` while a turn runs). Past messages stay; its runs leave Reports.
- Turns: a mention routes through the normal room queue. One turn per coding agent at a time (others show as `queued`); at most 30 minutes per
  turn; Stop = SIGINT, SIGTERM after 5 s, SIGKILL after 5 s more. An untested/missing CLI or an unavailable workspace fails the reply with a
  sentence in the room (`422`, never retried). The CLI's pid, process group and start time are stored right after the spawn; a restart first stops what is left of each recorded group (only when pid and start time still match; SIGTERM, then SIGKILL) and then marks running turns `interrupted` ("Score restarted while this ran"); the CLI session id
  is kept so the next message resumes it. Runs carry `runtime` and `costKind`; run ids start with `cr_`.
- Security: the CLI gets an allowlisted environment (no Score variables, nothing named `*_API_KEY`/`*TOKEN*`/`*SECRET*`); the prompt goes on stdin,
  never in argv; output is redacted before it is stored; Claude Code runs with deny rules for `~/.hermes`, `~/.score`, `~/.ssh` and `.env*`.
  The sandbox limits what an agent can change, **not what it can read** (Codex has no read rules): the Add agent form says so.

### Workspace (Team › agent › Workspace)
The agent's Hermes working folder (`terminal.cwd`), browsed and edited from Score. **Every** workspace endpoint is **H**
(paired browser), reads included, because the files can hold secrets. `path` is POSIX and relative to the root; the root
itself is `''`. Schemas: `Workspace*` in `packages/contract/src/workspace.ts`.
- **H** `GET /api/agents/:agentId/workspace` → `WorkspaceInfo` `{ root: string | null; available: boolean; reason: string | null }`.
  Unavailable (with the reason) when the terminal backend is not `local`, `terminal.cwd` is unset, `.` or relative, or the
  folder fails the root checks: `/`, the home folder or a parent of it, `~/.hermes`, `~/.score`, `~/.ssh` (or Score's/Hermes's
  configured homes, and the default `~/.hermes` even when another Hermes home is configured) or inside them, inside `.git` or
  a protected-name folder, missing, not a directory, or owned by another user.
- **Root identity.** Every file route below (`tree`, `file` GET/PUT, `entries`, `move`, `upload`, `git`) accepts `?root=<the
  WorkspaceInfo.root the browser is showing>`; when present and not the agent's current root the request is refused
  `409 workspace_changed` (`details.root` = the current root) and nothing is touched. The web always sends it and includes
  it in its query keys. `PUT …/file` re-checks the file right before replacing it (`412 precondition_failed` if an outside
  writer changed it meanwhile).
- **H** `PUT /api/agents/:agentId/workspace/root` `{ path }` → `WorkspaceInfo`. Same checks plus the folder must exist (never
  created); writes `terminal.cwd` through `hermes -p <profile> config set`. Refusal → `409 workspace_unavailable` with the reason;
  `~/…` is expanded. The stored value is the resolved real path. Logged.
- **H** `GET …/workspace/tree?path=` → `WorkspaceTree` `{ entries: { name; kind: 'file'|'dir'|'symlink'; size; mtime; hidden }[] }`
  (one level; folders first; blocked names are never listed; `.git` is listed but not its inside).
- **H** `GET …/workspace/file?path=[&download=1]`
  - text (UTF-8, no NUL, ≤ 1 MiB): `200 text/plain; charset=utf-8`, header `ETag` (quoted), `X-Content-Type-Options: nosniff`;
  - png/jpeg/gif/webp (extension + magic bytes, ≤ 25 MiB): the raw bytes, `Content-Disposition: inline`, nosniff, CSP `default-src 'none'; sandbox`;
  - pdf (same checks): as the download case below (`application/octet-stream`, `attachment`, CSP), never inline;
  - anything else: `200 application/json` `{ binary: true; size; reason: 'binary' | 'too_large' }`;
  - `download=1`: any file ≤ 25 MiB as `application/octet-stream`, `Content-Disposition: attachment`, nosniff.
  Symlinks are followed for reading only when they resolve inside the root and the resolved path is allowed.
- **H** `PUT …/workspace/file?path=` `{ content; etag: string | null }` → `{ etag }`. Atomic (temp file in the same directory,
  fsync, rename). `etag: null` creates and refuses an existing file (`409 exists`); a stale etag → `412 precondition_failed`
  with `details: { etag }` (current etag, or null when the file was removed). Content ≤ 1 MiB, no NUL.
- **H** `POST …/workspace/entries` `{ path; kind: 'file'|'dir' }` → `201 {}` (`409 exists`) · `POST …/workspace/move` `{ from; to }` → `{}`
  (never overwrites: `409 exists`) · `DELETE …/workspace/entries?path=[&recursive=1]` → `{}` (a non-empty folder without
  `recursive` → `409 not_empty`; a folder holding protected files or `.git` → `409 protected_inside`, never deleted from
  here; the UI asks for a typed confirmation first).
- **H** `GET …/workspace/git` → `{ branch: string; changed: number; ahead: number; behind: number } | null` (`WorkspaceGit`).
  The repository around the root (the root or a parent), from one read-only `git status --porcelain=v1 -b` (no index lock,
  fsmonitor and hooks off, system/user git config and inherited `GIT_*` variables ignored, 5 s timeout); `changed` counts
  every non-clean path, each untracked file individually (`--untracked-files=all`); `null` when there is no repository, git
  is missing, the call fails or the repository's own config defines filters, fsmonitor, a hooks path, textconv or includes
  (git would run them; the UI then shows no badge). Never runs a writing git command.
- **H** `POST …/workspace/upload?path=` raw body, `Content-Type: application/octet-stream`, ≤ 25 MiB, `path` = the new file's
  path → `201 { path, size }` (`409 exists`).
- **Links (web only, no endpoint).** In chat Markdown `workspace://<path>` and `workspace://<agentId>/<path>` open that file
  in the agent's Workspace tab at `/team/:agentId/workspace?path=<path>` (the deep link works on a fresh load too). The first
  segment is an agent id only when it names a known agent; otherwise the file belongs to the message's author. Paths are
  checked by the endpoints above, so a blocked or missing file shows the normal error.
- Path rules (all endpoints): `..`, NUL, absolute paths → `400 bad_path`; any component matching the blocked list (`.env*`,
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`, `auth.json`, `.netrc`, case-insensitive) or
  anything inside `.git/` → `403 blocked`; leaving the root or reaching Hermes/Score/SSH data → `403 outside_workspace`/`blocked`;
  symlink component or target in a mutation → `403 symlink`; a folder swapped during the request → `409 changed`; too large →
  `413 payload_too_large`; missing → `404 not_found`. Every write is logged (operation, path, size; never content).
  Not a guarantee for arbitrarily named secret files.

## 9. Reports

- `GET /api/reports?range=today|7d|30d&tz=` or `GET /api/reports?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD&tz=` →
  ```ts
  {
    range
    summary: string
    totals: {
      tasksFinished: number
      runs: number
      firstPassRate: number | null
      medianTaskSec: number | null
      spendUsd: number | null
      spendEstimated?: boolean /* 7.2: includes a coding agent's API-price equivalent */
      spendExcluded?: AgentId[] /* 7.2: coding agents whose CLI gave no cost; left out, never counted as 0 */
      cacheHitRate: number | null /* 5.29: over the agents that report cache tokens */
    }
    byDay: {
      date: string
      perAgent: Record<AgentId, number>
    }
    ;[]
    timeSplit: {
      agentId
      workingPct: number
      waitingOnYouPct: number
      waitingOnAgentPct: number
    }
    ;[]
    byAgent: {
      agentId
      finished: number
      runs: number
      medianSec: number | null
      firstPassRate: number | null /* null = n/a, reviews */
      spendUsd: number | null
      spendBasis?: CostKind /* 7.2: coding agents only (absent = Hermes, reported) */
      runtime?: Runtime /* 7.2 */
      cacheHitRate: number | null /* 5.29 */
    }
    ;[]
    trend: { date: string; runs: number; spendUsd: number | null }[] /* 5.29: last 30 local days, any range */
    approvals: {
      asked: number
      approved: number
      denied: number
      medianWaitSec: number | null
      insight: string | null
    }
    unattributed?: { runs: number; workingSec: number } /* 5.17a-1, attempts on only */
  }
  ```
  **Kanban attempts in Reports (5.17a-1, attempts on).** An attempt of a known agent counts as one of that agent's runs (`byAgent.runs`,
  `totals.runs`, `trend.runs`); its interval is working time only when its evidence is `proven`, and an open attempt that stopped being
  observed ends at its observation boundary. Attempts without a known agent are counted only in `unattributed` (`runs` started in the range,
  `workingSec` = merged proven intervals), never in `totals`, `byAgent`, `trend` or spend. Copies from an earlier history of the same source
  are counted once. Session spend is unchanged and stays per session. The CSV has the same per-agent `Runs` and, when `unattributed`
  exists, a last row `Unattributed` with its run count.
  Definitions (from Hermes Kanban history, read-only): a task is finished when `completed_at` falls in the range (day
  buckets in the server's time zone); task time = created → completed; reviewed = had `review_requested`, first pass =
  reviewed and never `changes_requested` (null when nothing was reviewed). Time split per agent (integer %, sum 100):
  the three categories are disjoint, with precedence working > waiting on you > waiting on another agent: working =
  a run is active (guardian approval time included); waiting on you = open human approvals and `blocked` intervals,
  minus time already working; waiting on another agent = waiting for dependencies (created → `promoted`) and in review
  (`review_requested` → the next `completed`/`changes_requested` by event id), attributed to the implementer named on the
  request, not the task's current assignee, minus time already working or waiting on you. An hour of active run with a human
  approval open the whole hour counts as working only. Spend = Hermes session costs (actual, else estimated);
  null when unknown. `totals.spendUsd` is null when any agent's spend is unknown (never a partial sum).
  **Coding agents (7.2).** Their spend is the sum of their own runs' `costUsd` in the range: Claude Code reports a cost that is an
  API-price equivalent, so the row says `spendBasis: 'estimated'` (and `totals.spendEstimated`); Codex reports tokens only, so its row
  is `spendUsd: null`, `spendBasis: 'unknown'`, and it is listed in `totals.spendExcluded` and left out of the total (not counted as 0).
  An agent with no run in the range has no `spendBasis`. The 30-day `trend` spend covers Hermes sessions only.
- **Cache hit rate and trend (5.29).** `cacheHitRate` = cache-read tokens / (uncached input + cache-read + cache-write) of the
  Hermes sessions that *started* in the range (a session's counters are cumulative), read-only from each profile's
  `state.db` through the report-facts adapter. `null` ("—") when no such session exists, a counter is missing, or Hermes
  never recorded a cache token (a provider without caching is not a 0% hit rate). The total is over the agents that report;
  null when none does. `trend` is always the last 30 local days (oldest first) whatever `range` is: `runs` = runs started
  that day; `spendUsd` = that day's share of Hermes session costs from Score's cost snapshots (the same method as the
  range spend), `null` when any agent's reading is missing for the day (e.g. before Score started sampling), never zero.
  The Reports page draws it with an accessible table fallback.
- **Display currency (5.29).** Reports and the API stay in USD. `GET /api/settings/currency` → `{ code: string /* ISO-4217
  shape, ^[A-Z]{3}$ */; rate: number /* units of `code` per 1 USD, typed by the person; no network fetch */ }` (default
  `{ code: 'USD', rate: 1 }`); **H** `PUT /api/settings/currency` `{ code; rate }` → the stored value (`400` for a bad code or a
  rate that is not > 0; USD is always stored with rate 1). Stored in Score's `meta` table (key `display_currency`). The page
  multiplies and rounds once to the displayed cent; Reports offers a USD / `code` toggle (remembered per browser).
- `GET /api/reports/export.csv?range=&from=&to=&tz=` → `text/csv` (same query as the report)
- Both take an optional `tz` (IANA zone, e.g. `Europe/London`): days and "today" are the viewer's, not the server's
  (often UTC). An unknown zone is `400`. Without it, the server's zone is used.
- `range=custom` requires `from` and `to` (and they are rejected for the presets): both are inclusive local days in `tz`,
  `from <= to`, at most 366 days apart, `to` not after today; otherwise `400 bad_request` with the reason. The response's
  `range` is `custom` and `byDay` has one entry per local day from `from` to `to`; the window ends at the end of `to` (or
  now, when `to` is today). Reports read only Score's own database and Hermes' read-only SQLite: agent ids come from Score's
  agent projection, never from a Hermes CLI call, so the answer does not wait on Hermes.

- **Journey (7.4c).** `GET /api/reports/journey?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=` (same day rules as `range=custom`: inclusive local
  days in `tz`, `from <= to`, at most 366 days, `to` not after today; otherwise `400 bad_request`) →
  ```ts
  {
    from: string; to: string /* the days asked for */
    truncated: boolean /* a bound dropped older events */
    agents: { id: AgentId; events: { at: string /* ISO */; kind: 'task_done' | 'note_written' | 'skill_changed' | 'memory_changed';
                                    label: string; ref: string | null }[] }[]
  }
  ```
  One entry per agent in Score's agent projection (even with no events), events newest first. Sources: tasks completed (Hermes
  Kanban `completed_at`, title from Score's task projection, `ref` = task id), knowledge notes written (Score's vault index, notes whose
  last author is `agent:<id>`, `label` = note title, `ref` = note path), skills (a skill's `SKILL.md` file time, `label` = skill name, `ref`
  null) and memory (the profile's memory files' modified times, `label` = "Memory file changed", `ref` null). Memory contents are never
  read or returned, and skills are by name only. Hermes files are read only through the adapter (`hermes/`). Bounds: at most 500 events per
  agent and 2,000 in all, newest kept (the oldest are dropped first, `truncated: true`). File times are coarse: a mark means "this file
  changed", not "something was added".

## 10. Settings

- `GET /api/settings/providers` → `{ items: { id: string; label: string; status: 'connected' | 'needs_signin' | 'missing'
detail: string /* "sk-or-••••", "Your ChatGPT plan" */; usedBy: AgentId[];
signIn?: 'device_code' | 'api_key' | 'terminal' /* how Connect works from the browser (D2.7); absent = terminal */ }[] }`
- **H** `POST /api/settings/providers/:id/connect` → `{ next: 'done' | 'device_code' | 'run_in_terminal'; command?: string; url?: string;
code?: string; signInId?: string; expiresAt?: string }`. For a `device_code` provider this starts the sign-in (D2.7) and
  returns its link, code and id; `command` is always included as the terminal fallback. A second call while one is
  waiting returns the same sign-in. If Hermes prints no link and code within 30 s (e.g. the profile is set to a browser
  login), the answer is `run_in_terminal` with the command.
- `GET /api/settings/sign-ins/:signInId` → `SignIn` `{ id; providerId; state: 'waiting' | 'connected' | 'failed' | 'expired' |
'cancelled'; url: string | null; code: string | null; expiresAt: string; message: string | null }` · **H**
  `DELETE /api/settings/sign-ins/:signInId` → `SignIn` (cancelled). In-memory; unknown ids → 404.
- **H** `POST /api/settings/providers/:id/key` `{ apiKey: string; label?: string }` → the
  provider item, after `hermes auth list` shows the new credential (`409 not_verified` otherwise). A provider that
  doesn't take a key → `409 not_supported`;
  a key already being added for that provider → `409 conflict`. The key never appears in any response, log or receipt
  (the receipt's body hash is an HMAC under a per-process secret, so a retry after a restart is `409`, not a replay).
- `GET /api/models?q=&agentId=&all=` → `{ items: ModelOption[]; hiddenCount?: number }`, `ModelOption = { provider: string /* "" only for an alias row whose provider is unconfirmed */; providerLabel: string; model: string;
available: boolean; reason: string | null /* "Not on your plan" */; free: boolean; contextLength?: number | null /* tokens, when Hermes says */; price: { input: string; output: string } | null; alias?: string }`.
  Models of connected providers only (Hermes model options); `q` matches model or provider label, case-insensitive;
  at most 200 items, available first. When the chosen-models list (below) is not empty, only those models are listed and
  `hiddenCount` says how many matching models were left out; `all=1` ignores the list ("Show all"). With `agentId` and a `q`
  that is part of one of that agent's alias names, the alias's model comes first with `alias` set.
- `GET|PUT /api/settings/model-visibility` (5.31) `{ items: { provider; model }[] }`: the models the pickers show by default
  (Score's own table; empty = every model). PUT replaces the list (human only).
- `POST /api/settings/providers/local` `{ label; baseUrl; model }` → provider item
- `GET /api/settings/connections` → `{ toolServers: { id; label; status: 'ok'|'needs_signin'|'error'; usedBy: AgentId[] | 'everyone' }[]
messaging: { platform; label; status: 'connected'|'disconnected'; detail: string | null }[] }`
- `POST /api/settings/tool-servers` `{ name; command?: string[]; url?: string }`
- `POST /api/settings/messaging/:platform/connect` → `ConnectResult`: `next: 'form'` for platforms that can be set up in
  the browser (token based), else `run_in_terminal` with the command (WhatsApp QR and other interactive pairings).
- `GET /api/settings/messaging/:platform/fields` → `{ fields: { key; label; help: string | null; url: string | null;
  secret: boolean; required: boolean }[]; browserSetup: boolean }`. Field metadata is an adapter-side table (Hermes has no
  read-only CLI that lists env-var metadata) mirroring `hermes_cli/config_defaults.py`. `browserSetup: false` = no fields,
  use the terminal command from `connect`.
- **H** `PUT /api/settings/messaging/:platform` `{ values: Record<ENV_KEY, string>; agentId?: AgentId }` → the connection row
  `{ platform; label; status; detail }`. Keys must be in the platform's field list (`400` otherwise), every `required`
  field must be present and non-empty, empty optional values are skipped. Each value is written with `hermes [-p <profile>]
  config set KEY value` (argv array, profile of `agentId`, default profile when absent). The route uses the HMAC receipt
  (`secretBody`): values are never logged, stored, echoed or put in a receipt, and error messages are redacted. The gateway
  reads its tokens at start, so the row stays as it was until the gateway restarts (Score has no gateway restart action;
  the UI says so).
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
- `GET /api/settings/plugins?agent=<id>` → `PluginsResponse` `{ items: { id; label; enabled: boolean; locked: boolean;
description: string | null }[] }` (one profile's `hermes plugins list`, bundled included) · **H**
  `PATCH /api/settings/plugins/:id?agent=<id>` `{ enabled }` → the verified item. `locked` = the Score bridge, which Score
  never disables (`409`); `409` too when Hermes didn't apply the change; `404` for an unknown agent or plugin. Enabling a
  non-bundled plugin that declares capabilities leaves them ungranted (Hermes fails closed without a terminal).
- `GET /api/settings/config?q=` → `{ items: { key: string; value: unknown; file: string; description: string | null }[] }`
  (name and comment search, ≤ 50). Secret-bearing and env-backed keys (credential-shaped names, env/header maps,
  provider and MCP server containers) are never listed or writable; only keys known to the tested Hermes version are.
- `POST /api/settings/config/preview` `{ changes: { key; value }[] }` → `{ diff: string; file: string; hash: string }`
  (`hash` = sha256 over the diff, the current values and the new values). `400` for unknown or protected keys.
- **H** `POST /api/settings/config/apply` `{ changes; expectedDiffHash: string }` → `{ ok: true; restartRequired: boolean }`;
  `409 conflict` when the recomputed hash differs (config changed since the preview; preview again), `502` when Hermes
  refuses or doesn't keep a value.
- **H** `POST /api/settings/hermes/check` → `HermesCheck` = `{ hash: string; build: { version: string | null; codeSha: string | null;
fingerprint: string }; parts: { name: string; status: 'same' | 'added' | 'changed' | 'removed'; detail: string }[];
compatible: boolean }`. Read-only: compares the running build (version, code sha, CLI string, capabilities, kanban and
  state schema hashes, the bridge's hook names, the private approval functions, pattern keys) with the tested and accepted
  builds. `compatible` = capabilities, schemas, hooks and private functions unchanged (new pattern keys are allowed).
  `hash` = sha256 over `build` and `parts`.
- **H** `POST /api/settings/hermes/accept` `{ hash }` → `{ ok: true }`: records this build in Score's own accepted-builds
  store (`$SCORE_HOME`, never the repo registry) so the compatibility gate re-enables `gateway-approvals`. `409 conflict`
  when the build changed since the check (hash differs), `409 not_compatible` when the check is not compatible.
- Theme (light, dark, system) is a per-browser setting in `localStorage` (`score.theme`); there is no settings/ui endpoint.

## 12. Knowledge (central vault; design docs/briefs/6.0-workspace-knowledge.md § 6.2)
Score's own Markdown vault (default `~/score-vault`, `$SCORE_VAULT`), git-versioned; the files are the source of truth and
Score's DB only indexes them. Paths are POSIX, relative to the vault; notes end in `.md`, attachments live under
`attachments/`. Schemas in `packages/contract/src/knowledge.ts`. Writes from browsers are **H**; agents use the bridge
tools (§11, task 6.4) and are attributed in git and in `knowledge.changed`.
- `GET /api/knowledge` → `KnowledgeInfo` `{ vault; notes; gitAvailable; agentAccess }`
- `GET /api/knowledge/tree` → `{ folders: string[]; notes: KnowledgeNoteSummary[] }` (`{ path; title; mtime; lastAuthor }`)
- `GET /api/knowledge/notes/*path` → `KnowledgeNote` `{ path; title; frontmatter; body; etag; mtime; links: { target;
  path | null }[]; backlinks: { path; title }[]; lastAuthor }`. Title: frontmatter `title`, else the first `# H1`, else
  the file name. Wikilinks `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]` resolve Obsidian-style (exact path,
  then a unique basename, case-insensitive); unresolved links have `path: null`.
- **H** `PUT /api/knowledge/notes/*path` `{ body; frontmatter?; etag | null }` → `{ etag; path }`; `412
  precondition_failed` with `details.etag` on a stale etag; `etag: null` creates and refuses an existing note (`409
  exists`); missing folders are created. Atomic write, then a git commit (author `You`); rapid edits of one note by one
  author within 60 s amend Score's own last commit when it is still `HEAD`. Before any save, move, delete or restore Score
  commits outside edits as "Outside changes"; if that snapshot fails the operation is refused `503 git_unavailable` (nothing
  is overwritten), and a save whose note changed on disk meanwhile gets `412` with the new etag. Agent `write`/`append`
  from an observe-only producer (`isolation: 'unknown'`) → `403 observe_only`.
- **H** `POST /api/knowledge/move` `{ from; to; updateLinks }` → `{ path; updatedNotes }` (two commits: the pure rename, then the link edits, so
  git follows the file; `409 exists`; `413` and nothing moved when a link rewrite would push a note over 8 MiB; links added
  outside Score since the last scan are included).
- **H** `DELETE /api/knowledge/notes/*path` → `204` (owner only; agents have no delete).
- `GET /api/knowledge/search?q=&limit=` (limit ≤ 50, default 20) → `{ items: { path; title; snippet }[] }`: FTS5-ranked;
  the query is tokenised into quoted terms (no FTS syntax from the user); `[[`/`]]` in `snippet` mark matches.
- `GET /api/knowledge/notes/*path/history` → `{ items: { commit; at; author; message }[] }` (newest first; empty with
  `gitAvailable: false`). `GET /api/knowledge/notes/*path/versions/:commit` → `{ commit; body }`.
- **H** `POST /api/knowledge/notes/*path/restore` `{ commit }` → `{ etag; path }` (a new commit with that version).
- **H** `PUT /api/knowledge/settings` `{ agentAccess: boolean }` → `KnowledgeInfo`.
- `GET /api/agents/:agentId/knowledge` → `{ enabled }`; **H** `PUT` same path `{ enabled }` → `{ enabled }`: the per-agent
  "Knowledge tools" switch (Team › agent › Tools; default on; the global `agentAccess` is checked first).
- `GET /api/knowledge/agent-usage` → `{ items: { agentId; writesToday }[] }`: agent writes since local midnight
  (Settings › Knowledge).
- Stream `knowledge.changed` after every change (Score's, an agent's, or an outside edit the watcher saw).
**Documents and zips (PLAN 6.6).** Files that are not Markdown notes live in the same vault and tree: `.pdf`, `.docx`,
`.csv`, `.json`, `.html`/`.htm`, images (png, jpeg, gif, webp) and `.zip`. `.md`/`.markdown` uploads and `.txt`
(stored as `<name>.md`) become notes. Limits: 25 MB per file; documents up to 10 MB are committed to the vault's git,
larger ones are stored but not versioned (`versioned: false`); extracted text is redacted (D6), cut at 2 MiB
(`textStatus: 'truncated'`) and indexed in its own FTS table. Text of PDF (`unpdf`) and DOCX (`mammoth`) is extracted in a
worker thread (20 s, 512 MB heap); a failure keeps the file with `textStatus: 'unavailable'`. Types are decided from
the bytes (magic numbers), never the extension or declared type alone. Names: no `..`, absolute, dot-segments or `.git`.
- `GET /api/knowledge/tree` now also returns `documents: KnowledgeDocumentSummary[]` `{ path; type; size; mtime;
  lastAuthor; versioned; textStatus }`; `GET /api/knowledge` also `documents` and `documentBytes`.
- **H** `PUT /api/knowledge/files/*path?onConflict=ask|keep|replace&mode=keep|unzip|preview&folder=` with the raw file as
  the body (`application/octet-stream`, at most 25 MB) -> `{ path; kind: 'note'|'document'; replaced }` (201). A name that
  exists answers `409 exists` with `details.existing[]` (`ask`, the default); `keep` adds ` (2)`, ` (3)` to the name;
  `replace` overwrites (a note keeps its history; a document is a new commit when versioned). Unsupported or
  mismatching content -> `415 unsupported_type`; over 25 MB -> `413`.
- Zip files (`mode`, default `keep`): `keep` stores the zip as a document (its file list shows on its page; not
  indexed); `preview` stores nothing and returns `KnowledgeZipPreview` `{ entries: { path; size; action; reason }[];
  more; extractCount }`; `unzip` extracts into `folder` (default: the zip's name) -> `KnowledgeUnzipResult` `{ folder;
  written[]; skipped[] }` in one commit "Unzipped <name>.zip". The zip is read in a worker thread: at most 1,000
  entries, 200 MB uncompressed in total, 100:1 compression ratio per entry (entries under 64 KiB exempt), sizes
  checked while inflating; entry paths are normalised and confined to the folder (no `..`, absolute paths, drive
  letters, dot-files, `.git`); symlinks and directories are ignored; nested zips are kept as files; only the allowed
  types are extracted, the rest are `skipped`. A clash anywhere in the batch answers `409 exists` (all clashing names in
  `details.existing`); one `onConflict` applies to the whole batch. A zip that breaks a limit -> `413 zip_limits`; an
  unreadable zip -> `415 unsupported_type`.
- `GET /api/knowledge/documents/*path` -> `KnowledgeDocument` (summary + `text` + `entries` for zips).
  `GET /api/knowledge/files/*path` -> the bytes (images inline, everything else as an attachment; always `nosniff` and a
  sandbox CSP). **H** `DELETE /api/knowledge/documents/*path` -> `204`.
- **H** `POST /api/knowledge/move` also moves documents (`updateLinks` is ignored for them).
- **H** `POST /api/knowledge/folders` `{ path }` -> `{ path }` (creates the folder, `409 exists` if present);
  **H** `DELETE /api/knowledge/folders/*path` -> `204` for an empty folder (`409 not_empty` otherwise).
- **H** `POST /api/knowledge/files-from-media` `{ mediaId; path; onConflict }` -> `KnowledgeUploadResult`: saves a chat
  upload (`/api/media`) into Knowledge ("Also save to Knowledge"); same rules as an upload.
- Search hits gain `kind: 'note'|'document'` and `type`. Agents: `knowledge_search` covers documents; `knowledge_read` on a
  document path returns its extracted text as `body` (`kind: 'document'`, `notice` when the text is missing or cut at
  256 KiB); `knowledge_list` adds `documents`. Agents cannot upload or delete documents; their write tools stay
  notes-only (`400 not_a_note`).
**Export (PLAN 6.7).** Notes and documents can be taken out of the vault.
- `GET /api/knowledge/notes/*path?download=1` -> the note's `.md` bytes exactly as stored (frontmatter included),
  `Content-Type: text/markdown; charset=utf-8`, `Content-Disposition: attachment` (UTF-8 `filename*`), `nosniff`.
- **H** `POST /api/knowledge/export/summary` `{ paths? | folder? | all? }` (exactly one) -> `KnowledgeExportSummary`
  `{ files; bytes; label }`: what the export would contain (shown before "Export the whole vault").
- **H** `POST /api/knowledge/export` same body -> `application/zip`, streamed, `Content-Disposition: attachment;
  filename="knowledge-<folder|selection|vault>-<YYYY-MM-DD>.zip"`. `paths` is a list of note/document paths (at most
  10,000; unknown paths answer `404 not_found`, a folder path is not accepted: use `folder`); `folder` exports everything
  under it, `all: true` the whole vault. Entries keep their path relative to the chosen root (`folder`) or to the vault
  (`paths`, `all`), notes and documents as stored (original bytes), plus a root `README.txt` saying what the archive is and
  when it was made. Never included: `.git`, dot-files and dot-folders, Score's index and extracted text, symlinks and
  anything that is not a regular file. At most 10,000 files and 1 GiB in total, checked from the stored sizes before
  anything is sent (`413 export_too_large`, `details: { files; bytes }`); an empty selection -> `400 bad_request`. Files are
  streamed from disk (bounded memory) and a file that changes while it is read is still sent as read; the export aborts
  after 10 minutes. Agents get no export tool.
**Editor and embedded images (PLAN 6.8).** A note opens in one live editor (formatted everywhere, raw Markdown only on the
active line; a Source toggle shows plain Markdown). No new endpoints; the note rules change:
- A note may be **8 MiB** (was 2 MiB; `KNOWLEDGE_NOTE_MAX_BYTES`), for `PUT`, uploads of `.md`, restore and move rewrites.
- Images live inside the note as `![alt](data:image/<type>;base64,...)`, made in the browser (downscaled to 1600 px on the
  longest side). On every write the server checks each such image outside code: type `png`, `jpeg`, `gif` or `webp` (SVG and
  any other type -> `415 unsupported_type`), well-formed base64, decoded size <= 1.5 MiB (`413 payload_too_large`), and
  magic bytes that match the declared type (`415 unsupported_type`). Export keeps the bytes as stored.
- Agents never see the base64: `knowledge_read` (bridge and MCP `knowledge.read`) replaces each embedded image with
  `[image: <alt>, <size>]` (e.g. `[image: diagram, 240 KB]`); the 256 KiB read cut applies after that. FTS indexing and
  snippets skip data URIs. `knowledge_write` and `knowledge_append` refuse a body that contains an embedded image
  (`400 images_not_allowed`); on `knowledge_write` over an existing note, a placeholder the agent kept (same text, in order) is
  turned back into the original image, so an edit by an agent does not delete the images it could not see; a placeholder it
  removed deletes that image.
- The web CSP already allows `img-src data:`; scripts and objects from data URIs stay blocked.
- Errors: path outside the vault, `..`, NUL, absolute, `.git` → `400 bad_path`; not a `.md` note where one is needed →
  `400 not_a_note`; too large (note > 8 MiB) → `413 payload_too_large`; missing → `404 not_found`.

## 11. Internal: bridge plugin ↔ server (not for the front end)

Served under `/bridge/v1` on the same port. Bridge tokens can't call `/api/*`, and browser sessions can't call
`/bridge/*`.

**Handshake**

- `POST /bridge/v1/hello`, auth `Bearer <~/.score/bridge.token>` (bootstrap secret, allowed for this call only):
  ```ts
  req: {
    profile: string
    pid: number
    incarnation: string /* random per process */
    kanbanTaskId: string | null
    isolation: 'in_process' | 'host' | 'unknown' /* unknown → observe only; actions disabled */
    pluginVersion: string
    hermes: {
      version: string
      codeSha: string
    }
    privateApis: Record<string, boolean> /* which hermes_private functions resolved */
  }
  res: {
    producerToken: string
    expiresAt: string
    enabled: {
      gatewayApprovals: boolean
      kanbanGrants: boolean
      watch: boolean
    }
  }
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

**Commands** (PLAN 5.33, server → plugin). A sibling long poll next to the decisions one, served only to a producer
whose `isolation` is not `unknown`; the plugin polls only while it runs inside a gateway (it needs Hermes's session store).

- `GET /bridge/v1/commands?wait=25` (`wait` 0–30) → `{ items: ({ commandId; kind: 'rewind'; sessionId; turns; since?; expiresAt } | { commandId; kind: 'compact'; sessionId; keepRecent?; expiresAt } | { commandId; kind: 'context_breakdown'; sessionId; expiresAt })[] }` (`expiresAt` = epoch seconds, issued + the 60 s answer
  time; the plugin refuses the command (`expired`) when it is past, checked under the transcript lock immediately before it mutates, so a
  command Score gave up on can't rewind later work; `since` = epoch seconds of the rewound message; the plugin then
  computes the number of turns itself, as every user turn of Hermes's alternation-repaired projection from the first one at or after
  `since`, uses `turns` only as Score's own count, refuses (`failed`) when the message shares a turn with an earlier unanswered
  one or no turn starts at/after `since`, counts, rewinds and verifies under one hold of Hermes's transcript lock (a concurrent `/undo`
  can't move the target; a target that changed is `failed`), and checks afterwards that no active user row from `since` remains, else `failed`). A
  command is handed to one polling producer of the profile once and is not redelivered.
- `POST /bridge/v1/commands/:commandId/result` `{ outcome: 'done' | 'nothing' | 'failed' | 'expired'; turnsUndone?; rewoundCount?;
  before?: { messages; tokens }; after?: { messages; tokens }; context?: SessionContextReading; error? }` → `204`. For `rewind`, the plugin calls the gateway session store's `rewind_session(sessionId, turns)` (what
  `/undo` uses; soft-deletes the rows, the next turn rebuilds from the active ones) from `hermes_private.py` and reports
  Hermes's `turns_undone` / `rewound_count`; `nothing` = Hermes had nothing to rewind. A command with no result within
  60 s is reported to the person as `no_answer`, and Score keeps the room's rewind hold (persisted in `rewind_holds`, restored after a
  restart) until `expiresAt` + 5 s, when the command can no longer act. The plugin remembers results by `commandId`, so a repeated command never
  rewinds twice.

  **`compact`** (PLAN 5.36): `keepRecent` = the number of recent exchanges kept word for word (Hermes's `/compress here N`
  form; absent = Hermes's full compression). Answer window 180 s (summarising is a model call), carried in `expiresAt`. The
  plugin (`hermes_private.compact_session`) works in `profile`'s own session store, under Hermes's transcript lock (the one
  rewind takes), loads the session's active rows, and runs Hermes's own manual-compress core
  (`agent.conversation_compression_manual.compress_now`, what `/compress` uses) on a throwaway agent built like the gateway's
  `_build_manual_compression_agent`; Hermes commits the result itself (in place or as a compression continuation, its
  choice). It checks `expiresAt` immediately before compressing, and answers `nothing` for a session shorter than Hermes's
  minimum, `failed` (`error`: `lock_held` while Hermes holds its compression lock for that session, `compact_failed`
  otherwise; never Hermes text) and `done` with Hermes's before/after message and token estimates. A command is run at most once
  per `commandId`; a repeated one returns the remembered result.

  **`context_breakdown`** (PLAN 5.36): a read-only query, answer window 20 s. The plugin (`hermes_private.context_breakdown`)
  asks Hermes's own context accounting for the session (`agent.context_breakdown.compute_session_context_breakdown`, what the
  `/context` command reports; no model call; a throwaway agent is built only to read its prompt, tool schemas and compressor)
  and answers `done` with `context: SessionContextReading` `{ window; used; model; source: 'provider_usage' |
  'provider_usage_plus_estimate' | 'local_estimate'; autoCompactAt: number | null; parts: { kind: 'system_prompt' |
  'tool_definitions' | 'rules' | 'skills' | 'mcp' | 'subagent_definitions' | 'memory' | 'conversation'; label; tokens }[] }`,
  or `nothing` for a session without rows, or `failed` (`context_failed`).

**Kanban denials** (D4.3, revised 2026-10-07): there are **no** grant endpoints. A Kanban worker's `post_tool_call`
event may carry `kanbanDenial: { patternKey: string; commandDigest: string; taskId: string; runId: number | null }`
when the plugin verified the unattended dangerous-command denial; the server shows it as a view-only approval card.
`enabled.kanbanGrants` in `hello` is reserved and always `false` until Hermes offers a one-shot grant API.

**Knowledge tools** (§12, task 6.4). `POST /bridge/v1/knowledge/{search|read|list|write|append}`, auth `Bearer
<producerToken>` (JSON body). The agent is the producer's `profile`; nothing in the body names an agent. Requests/responses
are `Bridge*Knowledge*` in `packages/contract/src/knowledge.ts`:
`search {query ≤500, limit 1-20}` → `{ items: {path; title; snippet}[] }`; `read {path}` → `{ path; title; body; etag;
truncated }` (body ≤ 256 KiB); `list {folder?}` → `{ folders; notes: {path; title; mtime}[]; truncated }` (≤ 200 entries);
`write {path; body; expectedEtag | null}` (null creates) → `{ etag; path }`; `append {path; text}` → `{ etag; path }` (server-side,
creates a missing note). Errors use the standard envelope: `403 knowledge_off` (global or per-agent switch off; message
"Knowledge is turned off for agents"), `404 not_found`, `400 bad_path|not_a_note`, `409 conflict` / `409 exists` with
`details.etag` (the current etag, so the model re-reads), `413 payload_too_large` (> 256 KiB per write),
`429 rate_limited` (60 writes/hour/agent; `details.retryAfterSeconds`). Agent text passes through `redact()` before it is
stored; commits are authored `<agentId> (agent)` and `knowledge.changed` carries `by: { agentId }`. There is no delete or
move for agents.

Hook → domain mapping lives in `apps/server/src/hermes/translate.ts`; payload fixtures in
`apps/server/test/fixtures/bridge/` (seeded from `docs/spike/`).

## 13. MCP access for agents (PLAN 7.4d; schemas in `packages/contract/src/mcp.ts`)
Score is an MCP server for its own agents (rooms, tasks, knowledge). Design: `docs/briefs/7.4-backlog.md` § 7.4d; review
changes: `docs/reviews/2026-10-09-phase7-lead.md`.

**Server.** Streamable HTTP, stateless (`POST` only, JSON responses; `GET`/`DELETE` → `405`), at `/bridge/mcp` on the
**loopback bridge listener only** (remote mode's `SCORE_BRIDGE_PORT`); it is not registered on the browser listener, where
the path is `404`. Requests with an `Origin` header or a non-loopback `Host` → `403`. Auth: `Authorization: Bearer scm_<43
base64url>`, a per-agent token Score stores as a SHA-256 hash and shows once. A missing, malformed, unknown, rotated or
revoked token → `401`; a valid token whose agent has MCP access off → `403 mcp_off`. Bridge tokens do not open this path,
and an MCP token is `401` on every `/api/*` and `/bridge/v1/*` path (its format is rejected before any handler). At most
120 requests per minute per agent (`429 rate_limited`).

**Identity** is the token's agent: no tool takes an agent argument (extra arguments are ignored). The tools below are the
whole surface; none approves anything, reads another agent's session or changes settings. Tool errors come back as MCP
tool results with `isError` and text `<code>: <message>`.

| Tool | Needs | Behaviour |
|---|---|---|
| `rooms.list` | access | Rooms the agent is a member of (not archived; ≤ 50): `{ rooms: { id; name; kind; members; lastMessage: { from; preview } \| null }[] }` |
| `rooms.post` `{ roomId; text ≤ 8 KiB }` | access + writes | Stores an agent-authored message (`to: []`, text part `via: 'mcp'`, redacted) in a room the agent is a member of; it starts no run and `@mentions` are not routed. `404` for other rooms; `409` while the room is rewinding or the agent is not ready. → `{ messageId }` |
| `tasks.list` `{ limit? ≤ 50 }` | access | Tasks where the agent is assignee or reviewer (`TaskSummary[]`) |
| `tasks.comment` `{ taskId; text ≤ 1500 }` | access + writes | A comment on such a task, text prefixed `[via MCP: <agentId>]`. `404` for other tasks |
| `knowledge.search` `{ query; limit? ≤ 20 }`, `knowledge.read` `{ path }` | access | As §11 knowledge tools (same global and per-agent knowledge switches, 256 KiB read cap) |
| `knowledge.write` `{ path; body; expectedEtag? }` | access + writes | As §11 `write` (256 KiB, 60 writes/hour/agent, etag/`409` rules); attributed to the agent in git |

`access` = `enabled`, `writes` = `writesEnabled`; both are **off by default** and checked on every call. Posting
(`rooms.post` and `tasks.comment` share one budget) is limited to 30 per hour per agent: `429 rate_limited` with
`details.retryAfterSeconds`; a post that fails gives its slot back.

**Browser API** (Team › agent › Tools › MCP access):
- `GET /api/agents/:agentId/mcp` → `McpAccess` `{ agentId; enabled; writesEnabled; hasToken; tokenCreatedAt; available;
  url; command; postsThisHour; postLimitPerHour }`. `available: false` (and `url`/`command: null`) when Score has no bridge
  listener (local single-port mode).
- **H** `PUT /api/agents/:agentId/mcp` `{ enabled?; writesEnabled? }` (at least one) → `McpAccess`.
- **H** `POST /api/agents/:agentId/mcp/token` → `{ token; access: McpAccess }`: creates or rotates (the old token stops
  working at once); the only response that carries the token (`Cache-Control: no-store`).
- **H** `DELETE /api/agents/:agentId/mcp/token` → `McpAccess` (revokes).

`command` is text for the owner to run in a terminal; **Score never runs it** and never writes Hermes configuration for
this: `hermes --profile <agentId> mcp add score --url http://127.0.0.1:<bridge port>/bridge/mcp --auth header`. Hermes
prompts for the bearer token and keeps it in the profile's own environment file (`MCP_SCORE_API_KEY`); the token is not part of the command. For an entry that already exists Hermes reuses the stored token without asking, so after a rotation the owner replaces that value in the profile's `.env` by hand and reloads MCP; the UI says so. Retiring an agent deletes its `mcp_access` row (token and both switches); the row also records the agent's lifecycle incarnation, and a removed, not-ready or different-incarnation agent has no access. A `tasks.comment` is stored with the agent as the comment author (`TaskActionRequest.author`, text prefixed `[via MCP]`). JSON-RPC batches are refused (`400`), and at most 4 requests per agent run at once. Text limits are in bytes (`413 payload_too_large`). Tokens (`scm_…`) are redacted wherever text is redacted.

## 14. Orchestrator (PLAN 7.5a; schemas in `packages/contract/src/orchestration.ts`; design docs/briefs/7.5-orchestrator.md v3 + v3.1)

A person gives a goal; a **lead** agent decides steps at runtime, hands them to team agents, asks the person when needed
and finishes. Score is the referee: every request the lead makes is validated against the run's limits, budget, gates and
fences. The lead works in short, event-driven **lead attempts** (one Hermes run each, fresh session `orc-<run>-lead-<n>`);
steps are Hermes runs of the target agent (session `orc-<run>-<step>-<attempt>`). Both go through an orchestration-only
dispatch path: fixed recipient, no mention routing, no plan materialisation, no room-context assembly, no automatic
summaries. Needs remote mode (the MCP server lives on the loopback bridge listener) and the lead's MCP access switch plus
token; the **writes** switch is not needed (§13 still governs `rooms.post`, `tasks.comment`, `knowledge.write`).

**Statuses.** Run: `running | paused | stopping | finishing | succeeded | finished_with_unresolved | stopped | failed`
(`pauseReason` explains `paused`). Step: `pending_gate | queued | admitted | succeeded | failed | unknown | cancelled |
blocked | rejected | not_started`. Attempt: `created | send_started | running | terminated | unknown | refused | abandoned`.
`terminated` needs **termination evidence** (7.1 v6): Hermes reported `completed` or `failed` from the run's own agent loop.
`cancelled`, `interrupted`, a lost run or a lost handle keep the attempt `unknown` ("not confirmed ended") until evidence or
a recorded human abandonment; neither a 404, a Stop acknowledgement nor a human decision is termination evidence.

**Acknowledgement.** Creating a run requires `acknowledgement.text === ORCH_ACKNOWLEDGEMENT_TEXT` (covers lead and steps).
Controls and accounting cover observed, Score-started work only.

### Browser API

- `GET /api/orchestrations/preflight?leadAgentId=&allowedAgents=a,b` → `Preflight` (`checks[]`: listener, lead ready, lead
  MCP access, lead MCP token, allowed agents, global fence, journal, capacity, quota, tool readiness (`unknown`: Hermes loads
  MCP tools per session, which Score cannot see), plus `gatePolicyNotes`, the acknowledgement text and the defaults).
- **H** `POST /api/orchestrations` `OrchestrationCreate` → `201 OrchestrationCreated` (`Idempotency-Key` honoured). The
  server re-runs the preflight; a failing check → `409 preflight_failed` `{ checks }`; capacity → `429 capacity`; storage
  quota → `409 quota_exhausted`; global fence → `409 fenced`. It creates the run's room and brief (owner: `orchestration`) and
  queues the first lead attempt.
- **S** `GET /api/orchestrations` → `OrchestrationList`; **S** `GET /api/orchestrations/:id` → `OrchestrationSnapshot`.
  Lists are not paginated (≤ 200 runs; finished runs are kept 90 days).
- Decisions (all **H**, all carry `orchestrationRevision` = the run `revision` the page showed; a stale one → `409
conflict`; gates and inquiries also carry their own `expectedRevision`; the response is the new `OrchestrationSummary`):
  - `POST …/:id/gates/:gateId/decision` `GateDecision` — approve admits exactly the frozen payload; reject marks the step
    `rejected`, blocks its dependents and wakes the lead.
  - `POST …/:id/inquiries/:inquiryId/answer` `InquiryAnswer` — the answer is data for the next lead turn; it never changes
    permissions.
  - `POST …/:id/limits` `LimitsDecision` — raise/clear the budget or deadline, or `acceptUnknownSpend`.
  - `POST …/:id/pause`, `…/resume`, `…/stop` `RunControl`. Resume never lifts a cancel fence, an unknown-attempt fence or the
    global fence. **Stop ignores a stale `orchestrationRevision`** (it can only reduce risk); it is an admission barrier: one
    transaction fences all further admissions, retires queued steps (`not_started: stopped`), withdraws gates and inquiries,
    refuses attempts not yet sent and owes Hermes a Stop on every attempt that may be running (retried until acknowledged;
    a run handle that arrives after the Stop is stopped at once). The run is `stopping` until every attempt is terminated
    (evidence) or abandoned, then `stopped`.
  - `POST …/:id/waiver` `WaiverDecision` — "continue while a cancelled step may still run". Recorded; not termination evidence.
  - `POST …/:id/remap` `RemapDecision` `{ agentId, frozenIncarnation, currentIncarnation, orchestrationRevision, acknowledge: true }` —
    "use the new <agent> for this run" (fix batch H). A run freezes the incarnation of its lead and of every allowed agent
    when it starts. While an agent's current incarnation differs, `needsYou` lists `{ kind: 'remap', agentId, role,
    frozenIncarnation, currentIncarnation }`; `orch.assign` for that agent is refused `agent_changed`, queued steps of the
    earlier incarnation are blocked (`agent_changed` / `agent_unavailable`), and the send barrier re-checks against the
    frozen mapping. The decision must name exactly the frozen and current incarnations the page showed (otherwise `409
    conflict`, as for a stale `orchestrationRevision`); it updates the frozen mapping, is journaled (`remap` entry), wakes
    the lead and, for the lead, ends the `agent_unavailable` pause. Steps assigned under the old mapping stay blocked and
    are assigned again. A removed agent (`currentIncarnation: "untracked"`) cannot be remapped; the person can only Stop.
  - `POST …/:id/abandon` `AbandonDecision` — releases capacity and reservations of the listed unresolved attempts, keeps
    their owed stops, records that late results are ignored; the run then pauses (`pauseReason: abandonment`) until Resume.
- `GET /api/orchestrations/:id/events` → `OrchestrationEvents` `{ asOfSeq, events[] }` (PLAN 7.5b, additive). The run's event
  history in causal order, derived on read from the persisted rows (no new table): run start, every lead wake and end, every
  `orch.*` command with **Score's verdict** (`verdict: accepted|refused|retry|conflict`, `code`, one redacted line), step
  admissions and results (with a result preview), gate and inquiry open/decision, blocked/unknown/abandoned steps, and
  control actions (pause, resume, Stop, waiver, abandonment, finish request, end). Event `id`s are stable across reads;
  the browser refetches it on `orchestration.upserted` and diffs by id. It drives the live diagram's moving dots, the live
  log and the replay, so nothing in them is invented client-side. Not paginated (≤ 40 lead turns × 20 commands + steps).
- `GET /api/orchestrations/fence` → `GlobalFence`; **H** `POST /api/orchestrations/fence/lift` `FenceLift`. The global
  fence stops admission for all orchestrations; lifting is a recorded human decision after the reconciliation list and is
  never termination evidence.
- Stream (§2): `orchestration.upserted` (`OrchestrationSummary`, after every change; refetch the snapshot for detail) and
  `orchestration.fence.updated` (`GlobalFence`).

A stale revision answers `409 conflict` with `details.currentRevision`. `GET /api/orchestrations/:id` also carries, per
attempt, `state`, `evidence`, `unknownReason`, owed-Stop timestamps and spend, so the page can show "not confirmed ended".
Not in stage A: the Watch replay scoped to an attempt's session (design v3 "Watch scope"); orchestration frames stay in the
agent-wide Watch feed until 7.5b/7.5c, and the start screen says Watch shows them mixed with the agent's other work.

### MCP tools (`orch.*`, on the §13 server)

Every call takes `capability` (`orc_` + 43 base64url, per lead attempt) and `commandId` (1–64 chars `[A-Za-z0-9._:-]`, unique
within the lead attempt). Access: the agent's MCP **access** switch (not writes) **and** an active capability for that exact
agent incarnation; the capability binds (run, lead attempt, generation). Replies are a `OrchReceipt`
`{ status: ok|refused|retry|conflict|not_found, code?, message?, result? }` as JSON text of the MCP tool result.

| Tool                                                            | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orch.plan { entries[] ≤ 30 × 500 B }`                          | Replaces the visible plan; executes nothing                                                                                                                                                                                                                                                                                                                                                                                  |
| `orch.assign { agent, instruction ≤ 8 KiB, after?, replaces? }` | Queues a step → `{ stepId, gateId? }`. Refusals: `agent_not_allowed`, `agent_unavailable`, `step_limit`, `bad_dependency`, `budget_exceeded`, `deadline_passed`, `bad_replaces`, `quota`, `sealed`. `after` must name existing earlier steps of the run. Under `every-step` the gate is created in the same transaction and freezes agent + incarnation, instruction, dependencies, estimate and dependency result revisions |
| `orch.requestApproval { stepId }`                               | Under `lead-asks`: creates the same assignment-bound gate for a queued, not yet admitted step. Steps under `lead-asks` are not admitted while the lead attempt that created them runs; one with no gate is admitted afterwards                                                                                                                                                                                               |
| `orch.cancel { stepId }`                                        | Retires the step. If it was admitted: stop is owed and **all admissions in the run are fenced** until that attempt is terminated, abandoned or the person records a waiver                                                                                                                                                                                                                                                   |
| `orch.ask { question ≤ 2 KiB }`                                 | Opens an inquiry (Needs you); the answer arrives in the next lead input as data                                                                                                                                                                                                                                                                                                                                              |
| `orch.note { text ≤ 2 KiB }`                                    | A progress line in the run's room (agent message)                                                                                                                                                                                                                                                                                                                                                                            |
| `orch.finish { outcome, summary }`                              | Durable finish request: fences admissions, retires queued steps (`not_started: run_finishing`), withdraws open gates and inquiries, seals further commands, then drains. Succeeds only when every admitted attempt (the requesting one included) is terminated; otherwise `finished_with_unresolved`                                                                                                                         |
| `orch.receipt { commandId }`                                    | Returns a stored receipt (`not_found` if none) so the lead can verify after an uncertain reply                                                                                                                                                                                                                                                                                                                               |

Same `commandId` + same canonical payload → the stored receipt; different payload → `conflict`. A `retry` (the lead
attempt's admission is not recorded yet) and an unknown/stale capability store nothing. JSON-RPC and provider call ids are
never used for deduplication. At most 20 commands per lead attempt.

### Limits and capacity

Goal 8 KiB, instruction 8 KiB, plan ≤ 30 entries × 500 B, note/question 2 KiB, answer 4 KiB, result 8 KiB, rendered lead
input ≤ 64 KiB (results newest first, truncated with markers), step input ≤ 32 KiB, ≤ 30 steps, ≤ 40 lead turns, ≤ 3
concurrent steps per run. Global: ≤ 5 running orchestrations, ≤ 6 concurrent steps, ≤ 2 per agent; admitting, stopping,
paused-active and unknown attempts count. Storage reserve per run = (max steps + max lead turns) × (64 KiB + 8 KiB of receipts, transitions and associations) + 256 KiB
(kept for Stop and obligation records); a run does not start unless it fits in the remaining orchestration quota (200 MiB).

### Budget

Owner-set estimates per lead turn and per step. A reservation is taken once (step: at queueing, lead turn: at claim) and
transfers through admission; spend is read fresh per attempt. An attempt's spend is _settled_ only when it is terminated and
its session has no open run; until then it is _provisional_ and budgets use provisional + reservations. Unknown spend is
never zero: it pauses the run (`unknown_spend`) until the person accepts it or raises the limit. Auxiliary usage outside the
observed runs (summaries, titles) is not counted and the UI says so.

### Ownership and controls

The run's room and brief are owned by the orchestration. Ownership is `owned` while the run is `running|paused|stopping|
finishing`, `draining` once it is terminal but an owed Stop is unacknowledged or an attempt is `unknown` and not abandoned,
and `released` after that. Actions on owned or draining objects get `409 orchestration_owned` `{ orchestrationId, state,
action }` unless delegated:

| Action                                                                                                  | owned                                                                                                                              | draining                        | released                |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------- |
| Post / edit / delete / retry / rewind a message in the room, room members / archive, summaries (rename is allowed) | 409                                                                                                                                | 409                             | allowed (ordinary room) |
| `rooms.post` (MCP) into the room                                                                        | 409                                                                                                                                | 409                             | allowed                 |
| Stop a message run (`…/messages/:id/stop`), stop a flow node (`/api/flow/nodes/:id/stop`)               | 409 (use Stop)                                                                                                                     | 409                             | n/a                     |
| Brief pause / resume (`/api/briefs/:id/pause                                                            | resume`)                                                                                                                           | delegated to run pause / resume | 409                     | 409 |
| Plan Start on the room                                                                                  | 409                                                                                                                                | 409                             | 409                     |
| Team pause / agent pause                                                                                | independent holds: block admission, never cleared by run Resume                                                                    | same                            | n/a                     |
| Team resume / agent resume                                                                              | clears only its own holds; never lifts a run pause, fence or waiver                                                                | same                            | n/a                     |
| Retire / replace / pause the lead or a step agent                                                       | admission checks the frozen incarnation: a changed lead pauses the run (`agent_unavailable`), a changed step agent blocks the step; every change adds a `remap` Needs-you item | same                            | n/a                     |

Workflow runs (§15) are orchestrations with `planner = 'workflow'` and use this table unchanged for their room and brief
(same `409 orchestration_owned`, details also carry `planner: 'workflow'`). Their own actions:

| Action (§15)                                                                  | owned (`running`/`paused`/`stopping`/`finishing`)                          | draining                                  | released                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------- |
| Save a new version of a definition                                            | allowed (never changes a version a run uses)                               | allowed                                   | allowed                           |
| Delete a definition                                                           | `409 workflow_used` if any run ever used a version                         | same                                      | same                              |
| Start a run / re-run (new run, same version)                                  | allowed (capacity counts every run that is not released)                   | allowed                                   | allowed                           |
| Node-gate decision, assignment-gate decision                                  | allowed while the gate is `open`; else `409 not_open`                      | `409 not_open` (gates are withdrawn)      | `409 not_open`                    |
| Retry an `unresolved` node                                                    | allowed with attempts left, else `409 not_retryable`                       | `409 not_open`                            | `409 not_open`                    |
| Try again after `refusedLifetime` refused dispatches                          | allowed while the node waits for it, else `409 not_open`                   | `409 not_open`                            | `409 not_open`                    |
| Remap (workflow form)                                                         | allowed while an agent differs; `409 stale_plan` if the payloads changed   | `409 not_open`                            | `409 not_open`                    |
| Pause / resume / limits / waiver / abandon / Stop (`/api/workflow-runs/:id/…`) | as §14 (Stop never waits on a stale revision)                              | Stop records owed Stops; others `409`     | `409` (nothing to do)             |
| Workflow-room messages, brief controls, Start plan, `rooms.post`              | `409 orchestration_owned`                                                  | `409 orchestration_owned`                 | allowed (ordinary room)           |

Brief status of an owned brief comes from the run (`running`/`paused` while the run is, `done` for `succeeded`, `failed`
otherwise), never from turns between lead attempts.

### Safety rules in short

Capability: hashed at rest, stored input holds a placeholder, inserted only into the payload sent to Hermes (in memory),
new generation on re-dispatch, expires when the attempt ends; `orc_…` is redacted wherever text is redacted and step inputs
are scanned for the prefix (a match blocks admission). The execution journal (`$XDG_STATE_HOME/score/execution-journal`,
outside `$SCORE_HOME`) records, before the effect, each admission, run handle, Stop fence and global fence change; on start
any entry missing from or newer than the database puts the global admission fence on and lists exactly those entries.
Restore `$SCORE_HOME` only with `scripts/score restore <backup>` (sets the fence and the untrusted-history marker); a restore
done any other way on the same host and boot cannot be detected. A Hermes admission is never replayed after `send_started`:
the attempt is `unknown`.

**Termination provenance (fix batch H).** `runs.terminal_source` is `runtime` (Hermes reported the terminal status; NULL
is a legacy runtime row) or `recovered` (Hermes forgot the run and Score rebuilt `completed` from a matching assistant
reply in the session history). A recovered run keeps showing its text in chat, but for orchestration attempts it is **not**
termination evidence: the attempt becomes `unknown` with `unknownReason: "recovered_text_only"`, the text is recorded in the
run history (not accepted as the step result), no successor is admitted and its obligations stay until real evidence or a
recorded abandonment.

Upgrade: migration 0049 backfills `terminal_source` (`recovered` for a terminal run with the recovery's gap row, `runtime` for
every other terminal run) and turns every `terminated` attempt whose run is `recovered` into `unknown` (`recovered_text_only`),
which fences its run; a result already accepted from it stays visible.

**Manual Pause (fix batch H).** A person's Pause is its own hold (`manual_paused_at`), independent of budget, unknown-spend,
deadline and agent conditions. Pause on a run already paused by a condition keeps that reason and adds the hold; a limits
decision clears only its own condition (the run then stays paused as `person` while the hold exists); Resume clears only the
hold (a budget / unknown-spend / deadline pause stays until its limits decision). The run runs only when neither remains. The
`pause` journal entry is verified against the hold, so a database that lost it is fenced.

**Journaled authorization changes (fix batch H).** Besides admissions and fences, the journal records every change to a
run's limits (`authorization` entry with the resulting budget, deadline and unknown-spend acceptance), every team and agent
pause hold and its lift (`hold`), and every remap (`remap`). At start the newest entry of each kind is compared with the
database: a database with a higher budget, a later or missing deadline, an acceptance the journal says was revoked, a
missing pause hold or a missing remap puts the global fence on and lists the entry, even when nothing was dispatched
afterwards. Compaction keeps only the newest entry per run, hold target and remapped agent.

### 7.5a review round (Codex pre-merge review) — behaviour changes

- **Deadline expiry is a fence-and-drain, not a pause:** when `deadlineAt` passes the run is stopped exactly like Stop (queued work `not_started: stopped`, Stop owed on every admitted attempt), ends `stopped` with `endReason: "deadline expired"` once every attempt is terminated or abandoned. There is no `deadline` pause any more.
- **Stop on a finished run** (`finished_with_unresolved`/`failed`/…) with attempts that are not confirmed ended records the owed Stop on each of them without changing the status or releasing capacity; `409` only when there is nothing to stop.
- **Capacity** counts finished runs while any of their attempts is `unknown` and not abandoned.
- **Lifting the global fence never makes work sendable:** every attempt the journal records as sent is `unknown` (with its journaled handle attached) before the fence lifts, and the send barrier refuses it again.
- **Capability hygiene:** any `orch.*` field (ids included) that contains something shaped like a capability (`orc_` + 8 or more id characters, whatever precedes it) is refused with `capability_in_text` and stored nowhere.
- **Commands** are refused as soon as the lead's run is terminal in Hermes' record, before the executor reconciles it.
- **Streamed replies** of orchestration attempts are cut at 8 KiB with a `[reply truncated]` marker.
- **Spend** is settled only when the run's session is known and every other run in it ended `completed`/`failed`; compression continuations in other sessions remain unverifiable and keep reservations until abandonment (open item for the adapter).

### v3.2 amendments (Codex review of design v3)

- **Journal tombstones:** compaction turns each reconciled admission, Stop/Cancel fence and Finish/Pause/waiver/abandon transition into a permanent tombstone (same sequence number) and keeps a `checkpoint` so numbering never goes back; the file is replaced crash-safely (write, fsync, rename, fsync directory). Startup checks the database against tombstones, so a database older than any of them is detected after compaction. `finish`, `pause`/`resume`, `waiver`, `abandon`, cancel fences and fence lifts are journaled.
- **`orch.assign { needsApproval: true }`** (lead-asks only; `not_lead_asks` otherwise) creates the gate in the assign call. `orch.requestApproval` on a step that already has an attempt → `already_admitted`.
- **Preflight `tool_readiness`** asks the adapter which MCP tools the lead's serving Hermes lists (`HermesPort.mcpTools`): all `orch.*` present → ok; any missing → `fail` with "Reload MCP"; not establishable (the live adapter cannot ask yet) → `unknown` with the same instruction.
- Capability recovery: never sent → new generation (older ones revoked in the same transaction); handle known → observe, no POST; possibly sent without handle → `unknown`, fenced, no replay.
- Watch scoping to an attempt's session remains not done in 7.5a.

## 15. Workflows (PLAN 7.1a; schemas in `packages/contract/src/workflows.ts`; design docs/briefs/7.1-workflow-builder.md v8 – v8.3)

A **workflow definition** is a fixed graph of agent steps, human gates, branches, joins and ends. A **workflow run** is an
orchestration (§14) whose planner is that graph instead of a lead model: `orchestrations.planner = 'workflow'`. There are no
lead attempts, no capabilities and no MCP calls. Everything below the planner (admission authority, typed dispatch, journal,
fences, Stop / Finish barriers, owed stops, abandonment, budgets and reservations, deadlines, capacity, storage reserve,
termination evidence, ownership of the run's room and brief) is §14 unchanged. A run's `id` is its orchestration id.

Differences a client must know:

- Workflow runs are **not** listed by `GET /api/orchestrations` and not announced as `orchestration.upserted`; they have
  `GET /api/workflow-runs` and `workflow.run.upserted`. The §14 run routes answer `404 not_found` for a workflow run id; use
  the `/api/workflow-runs/:id/…` routes below. `orchestration.fence.updated` and the global fence are shared.
- Every browser mutation here is **H** (paired session) and carries `orchestrationRevision` = the run's `revision` the page
  showed (stale → `409 conflict`, `details.currentRevision`). Decisions that name a node or gate also carry that object's
  revision (`expectedNodeRevision`, gate `expectedRevision`). Stop ignores a stale revision, as in §14.
- Time is ISO-8601; money USD; unknown spend is `null`, never zero.

### Definitions

`WorkflowDefinition { name, description?, inputs[], nodes[], edges[] }`, ≤ 30 nodes, ≤ 100 edges, ≤ 10 inputs (name, label,
`required`, `maxChars` ≤ 4 KiB), ≤ 256 KiB in total, agent `instruction` template ≤ 32 KiB UTF-8, gate `question` ≤ 2 KiB.
Node ids are `[a-z][a-z0-9_-]{0,31}`.

| Node     | Fields                                                                                           | Ports (`edge.port`)                            |
| -------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `agent`  | `agentId`, `instruction`, `retries` 0–2, `estimateUsd?`, `onFailure: route\|fail_run`            | `ok`, `failed`                                 |
| `gate`   | `question`, `onReject: route\|stop_run`                                                          | `ok` (approved), `rejected`                    |
| `branch` | `subject` (an agent node), `rules[] ≤ 8` (`id`, `when`)                                          | each rule `id`, and `default` (required)       |
| `join`   | `mode: 'all'` (no first-joins)                                                                   | `ok`                                           |
| `end`    | —                                                                                                | none                                           |

Branch conditions are fixed: `verdict` is `passed|changes_requested`, `outcome` is `succeeded|failed`, `output_contains`
matches the **stored sanitized output** case-insensitively (the editor says so; it is advisory and never a gate). Templates
are plain substitution: `{{inputs.<name>}}`, `{{nodes.<id>.output}}`, `{{nodes.<id>.verdict}}`, each with an optional
`|default:"…"`. DAG only; several edges may leave one port (fan-out, one token per target). Per-node deadlines do not exist
(run deadline only). Versions are immutable once saved; editing saves a new version. Node `agentId`s are local ids.

**Validation** is one function used by the editor, save and start. Issues are `{ code, severity, nodeId, edgeId, field,
message }`; only `error`s block. Codes: limits (`too_many_nodes`, `too_many_edges`, `definition_too_large`,
`steps_over_limit` = Σ nodes × (retries + 1) > 30), structure (`duplicate_node_id`, `duplicate_edge_id`, `duplicate_edge`,
`duplicate_input`, `unknown_node`, `bad_port`, `no_root`, `bad_root_kind` (roots must be `agent` or `gate`), `cycle`,
`unreachable_node`, `no_end`, `end_has_outgoing`), failure routing (`unrouted_failure` = `onFailure: route` without a
`failed` edge, `unrouted_rejection`, `failure_edge_with_fail_run`, `port_unconnected`), branches (`branch_no_default`,
`branch_duplicate_rule`, `branch_subject_invalid` = not an agent ancestor, `branch_condition_unusable`), joins
(`join_needs_inputs`, `join_deadlock` = inputs from mutually exclusive branches without a `default` path), templates
(`template_syntax`, `template_unknown_input`, `template_unknown_node`, `template_self_reference`,
`template_forward_reference`, `template_not_ancestor`, `template_needs_default` = a conditional ancestor needs a default,
`template_field_unavailable`) and `agent_missing`.

- **S** `GET /api/workflows` → `WorkflowList` (summaries + retained-inventory counts).
- **S** `GET /api/workflows/:id` → `WorkflowDetail` (version list + latest). `GET /api/workflows/:id/versions/:version` →
  `WorkflowVersion`.
- `POST /api/workflows/validate` `WorkflowValidate` → `ValidationResult` (stores nothing, no pairing needed).
- **H** `POST /api/workflows` `WorkflowCreate` → `201 WorkflowVersion` (version 1). **H** `POST /api/workflows/:id/versions`
  `WorkflowVersionCreate { baseVersion, definition }` → `201 WorkflowVersion`; `baseVersion` must be the latest (`409
  conflict`, `details.latestVersion`). An invalid definition → `422 invalid_definition` `{ result: ValidationResult }`; limits
  (200 definitions, 20 versions each) → `409 quota_exhausted`.
- **H** `DELETE /api/workflows/:id` → `204`; `409 workflow_used` when any run ever used a version.
- `POST /api/workflows/:id/versions/:version/export` `WorkflowExportRequest` → `WorkflowExport` (format
  `score.workflow/1`): every free-text field passes `redact()`, `changes` lists every difference, `removePaths` drops fields
  the person removed, the result is revalidated, agents travel as `{ name, role }` descriptors, never as ids. It is described
  as "scrubbed", not "guaranteed secret-free". There is no import in 7.1.

### Runs

- `GET /api/workflow-runs/preflight?workflowId=&version=` → `WorkflowPreflight`: checks (`definition`, `agents` ready,
  `mapping`, `global_fence`, `journal`, `capacity`, `quota`), the agents the definition uses with their **current
  incarnations**, both gate-policy notes, `ORCH_ACKNOWLEDGEMENT_TEXT`, the spend note and the true maximum step count.
- **H** `POST /api/workflow-runs` `WorkflowRunCreate` → `201 WorkflowRunCreated` (`Idempotency-Key` honoured). The server
  re-runs the preflight; failing check → `409 preflight_failed` `{ checks }`; `429 capacity`; `409 quota_exhausted`; `409
  fenced`; `agentMap` must name exactly the incarnations the page showed (else `409 conflict`); inputs must fit the
  definition (`422 invalid_inputs`). Gate policy: `gates-only` (default; only gate nodes stop for the person) or
  `every-step` (each agent node also gets §14's assignment gate). It creates the run's room and brief (owner: orchestration)
  and freezes definition, inputs and mapping.
- **S** `GET /api/workflow-runs` → `WorkflowRunList`. **S** `GET /api/workflow-runs/:id` → `WorkflowRunSnapshot`
  (`asOfSeq` read in the same transaction). `GET /api/workflow-runs/:id/events` → `WorkflowRunEvents`: §14's causal event
  history plus `node_state`, `token`, `planner` and `graph_end` events, a `nodeId` on each and, on `token` events, the `edgeId` the token travelled (additive, 7.1b), derived on read.
- Stream: `workflow.run.upserted` (`WorkflowRunSummary`) after every change; refetch the snapshot for detail.
- Controls (**H**; bodies and semantics are §14's): `POST /api/workflow-runs/:id/{pause,resume,stop}` `RunControl`,
  `…/limits` `LimitsDecision`, `…/waiver` `WaiverDecision`, `…/abandon` `AbandonDecision` → the new `WorkflowRunSummary`.
- **Node gate** `POST /api/workflow-runs/:id/gates/:gateId/decision` `GateDecision` (§14's body). Applies to node gates and,
  under `every-step`, to assignment gates. A node gate is a **local graph node**: it never queues or rejects an executor
  assignment. Approve → `ok` token; reject → `rejected` token when the edge exists, else the run stops (Stop semantics). The
  decision is one transaction: gate status, token, node transition and journal entry.
- **Retry** `POST /api/workflow-runs/:id/nodes/:nodeId/retry` `WorkflowRetryDecision` → `WorkflowRunSummary`. Only for an
  `unresolved` node (its attempt was administratively abandoned) with logical attempts left; creates the next attempt as a
  `replaces` lineage step. `409 not_retryable` otherwise.
- **Try again** `POST /api/workflow-runs/:id/nodes/:nodeId/try-again` `WorkflowTryAgainDecision`: continues a node that
  stopped at `refusedLifetime` (20) refused dispatch generations (`needsYou.refusal_limit`). The alternative is Stop.
- **Remap** `POST /api/workflow-runs/:id/remap` `WorkflowRemapDecision`: §14's agent-level decision plus `plan`, the exact
  `{ nodeId, payloadHash }` list the Remap card showed. A different current plan → `409 stale_plan`.

### Graph semantics

**Planner principal.** Server-only (no capability, no MCP). Its commands (`assign`, `cancel`, `finish`) use the run-scoped
identity `wf:<run>:<node>:<attempt>:<verb>:<generation>` (`plannerCommandId`), stored in `wf_commands` with tool, payload
hash, receipt and outcome. Node→step mapping, token transitions and the receipt commit **atomically**; a crash before or
after a pass re-derives the same commands and a stored identity returns its receipt. Passes run only on wake causes; commands
per pass ≤ node count. **Waiting is not failing:** admission conditions that can change (budget, unknown spend, reservations,
capacity, agent capacity, fences, holds, quota, Hermes availability, deadline not yet passed) never store a refusal: the node
stays `ready` with `waitingFor` and is re-evaluated on the next wake cause with a **new generation**. Only permanent
refusals (validation, mapping mismatch with no remap possible, payload too large, limits that cannot change) fail the node,
with a recorded reason.

**Readiness is the graph's, not the executor's.** The executor's `after` is not used. An agent node is handed to the
executor, as a step with no `after`, only once its tokens say it is ready (routed failures, skips, joins and rejected-gate
routes resolved). The inputs it consumed — including routed failures and template defaults — are frozen in `wf_consumed`
(consumer attempt → producer attempt + output revision) in the same transaction.

| Node   | Ready when                      | Succeeds →                                        | Fails →                                                   | Cancelled / skipped →                       |
| ------ | ------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| agent  | all inputs resolved, ≥ 1 token  | `ok` token                                        | `failed` token if the edge exists (`route`), else the run fails | `skip` on every out edge                    |
| gate   | same                            | approve → `ok`                                    | reject → `rejected` token, else the run stops             | `skip`                                      |
| branch | same                            | one `branch` token on the first matching rule, else `default` | —                                                         | `skip`                                      |
| join   | every input resolved            | token if ≥ 1 input token and no unrouted failure  | —                                                         | `skip` if every input was skipped           |
| end    | any token                       | records an end token only                         | —                                                         | —                                           |

Token kinds: `ok | failed | rejected | skip | branch`. Roots (no incoming edge) each get one token at start (edge id `start:<node>`, produced by `__start`).

**Finish is strict.** Reaching an `end` records its token; the planner issues Finish only when the graph is terminal: no node
in `waiting|ready|gate_open|running|unresolved`, no queued or admitted step, no planner command without a receipt, and every
produced token consumed or at an `end`. A pending gate on another branch therefore always blocks Finish. **Two outcomes:**
the run's `status` is the executor's (`succeeded`, `finished_with_unresolved`, `failed`, `stopped`); `graphOutcome` is
`reached_end | failed | stopped` (`null` while running). A reached end with a node that failed unrouted is `failed`.
Abandon → Retry → B succeeds → end gives `status: finished_with_unresolved`, `graphOutcome: reached_end`, and
`outcomeNote` says so ("Graph reached the end — 1 abandoned attempt not confirmed ended"); summaries, the brief, history and
the UI show both.

**Retries and abandonment.** Logical attempts per node = `retries + 1` (≤ 3), counted across replacement lineage. A failed
attempt with attempts left becomes a new executor step that `replaces` the old one (new session `orc-<run>-<step>-<n>`).
Abandonment is administrative: it never produces a `failed` token; the node becomes `unresolved` and offers **Retry** (paired,
attempts left only) or Stop. A late result of an abandoned attempt is recorded and never consumed.

**Results and verdicts.** The verdict is parsed from the complete sanitized final reply **before** truncation, only for
attempts the runtime terminated: exactly one fenced `score-verdict` block with `{"verdict":"passed"|"changes_requested",
"reason":"…"}`; none, several or malformed → no verdict (branch rules on verdict take `default`). Stored: verdict, reason ≤
500 chars, `source: 'runtime'`, `outputTruncated`; output ≤ 32 KiB. Recovered or incomplete observation → no verdict and no
success (fix batch H/I). **Result eligibility:** an attempt that consumed another's result is checked through `wf_consumed`
when created and again at send; a consumed result that was withdrawn or whose revision moved retires every provably unsent
consumer (`input_withdrawn`) and withdraws its approvals.

**Payload bound.** The final dispatched text (wrappers, quoting, consumed results) is rendered and validated (≤ 32 KiB UTF-8)
**before** the assignment is frozen and its gate shown; rendering never clips. Oversized → the node fails at readiness with
the reason (`payload_too_large`). The gate shows the exact text and the dispatched payload's hash equals the approved hash.
The internal workflow assignment accepts 32 KiB; the MCP `orch.assign` keeps 8 KiB.

**Mapping.** Definitions reference local agent ids. A run freezes the incarnation of every agent it uses (and the executor's
`orc_agent_map`). Assignment and send re-check against the frozen map; a changed agent blocks only its nodes
(`waitingFor: 'remap'`) and `needsYou` lists a `remap` item with its `plan`. A remap decision moves every affected step to
`remapping`: provably unsent steps (no `send_started` in the database or the journal) are retired with disposition `remapped`
and re-created for the new incarnation (old gate withdrawn; under `every-step` the new frozen payload needs its own approval,
under `gates-only` the remap decision is that approval); possibly sent work keeps its attempt and obligations, the remap
applies to later work. Re-creations use no logical retry but count against `maxSteps`; ≤ 2 remaps per node. Runs from before
the migration get their mapping backfilled from their attempts' recorded incarnations (journaled).

**Dispatch generations (v8.2 / v8.3).** Every send of an attempt has a generation `g` (1, 2, …): `send_started(attempt, g)` is
journaled before the adapter call. A proven refusal (`not_dispatched`) journals `send_refused(attempt, g)` in the transaction
that returns the attempt to `created`; any other outcome keeps it sent/unknown. The send barrier and restore verification treat
an attempt as sent iff its latest generation has `send_started` without `send_refused`. After 5 consecutive refused
generations the node waits `hermes_unavailable` and retries on the next `admission_revision` change caused by agent readiness
or every 10 minutes; a successful send resets the count. The journal keeps, per attempt, a **witness** `{attempt,
lastGeneration, lastState, refusedCount}`; compaction folds older generations into it (crash-safe, keeping the latest
generation, its state and the monotonic sequence). After **20** refused generations an attempt stops retrying on its own:
workflow nodes show `needsYou.refusal_limit` ("Hermes has refused this step 20 times — Try again / Stop the run"; paired,
revision-bound, journaled); in orchestrations the step fails with disposition `hermes_refused` and the lead decides.

**Durable wakes.** A global `admission_revision` (`orc_global`) increments in the same transaction as every change that can
make waiting work admissible (limits raised, Resume of run/agent/team, fence lift, waiver, capacity or quota released by any
run, agent readiness). Each run with waiting work records the revision it last evaluated; the executor re-evaluates runs whose
revision is behind, also at startup. A `ready` + waiting node is a wake source, so a workflow never pauses `no_wake_source`
while it has waiting nodes.

**Spend (honest).** The adapter reports evidence per attempt `{ attributed, lineageComplete, fresh, costScope }`. Live Hermes
cannot prove `lineageComplete` and reports tokens, usually not dollars, so its spend is **never settled**: provisional,
reservations held until the run ends, and `spend.note` says "spend not settled — Hermes doesn't report complete costs".
Unknown-spend acceptance is a risk decision, never evidence. The fake adapter can report full evidence.

**Storage.** The per-run charge covers orchestration and workflow rows, receipts, owned intents, the run room's messages and
`message_runs`, its attempts' `runs`/tool rows and control history (see `StorageInventory`); retained definition versions are
charged globally (≤ 200 × 20 × 256 KiB). Control history is ≤ 200 records per run (older ones fold into counters; journaled
transitions stay); 64 KiB per run is protected for Stop and obligation evidence. Charges are released only when every
associated row is deleted (pruning deletes them together; a tombstone stays). Watch and media keep their global retention
and are not charged per run.

**Watch.** Per-attempt filtering is not part of 7.1: a node's Watch link opens the agent's Watch at the attempt's time window,
labelled "agent-wide: may include other work".

**Implementation notes (7.1a).** Observed tool and thinking rows of a run's attempts are charged to its allowance at the writer and dropped when it is used up; the inventory lists them (`tool_rows`, `thinking`). A version's `used` flag is permanent (it survives pruning of its runs). The readiness evidence of a step (the producers whose results made its node ready) is recorded in `consumed` even when the text does not use it. A consumed entry of kind `default` for a producer that never ran (skipped) has `producerAttempt: 0`. A re-created step (retry, remap) is gated again under `every-step`. The remap re-creation
shares the logical attempt number with the step it replaces; its command identity differs by planner generation, which the
remap decision increments. The validation codes `join_deadlock` and `agent_missing` are reserved: with `skip` tokens an `all`
join always resolves, and an empty `agentId` cannot pass the schema. The 20-refusal limit, the five-in-a-row wait and the
ten-minute timer are the same for orchestration step attempts (the executor owns them); only their end differs (see above).

### Fake mode

`SCORE_MODE=fake` runs workflows against the fake adapter with the same executor. Markers in a step's text script the agent:
`[fake:hold]` (stays running until stopped or ended), `[fake:fail]` (the run ends `failed`), `[fake:verdict:passed]` /
`[fake:verdict:changes_requested]` (reply with a `score-verdict` block) and `[fake:refuse:N]` (the first N dispatches are
refused as proven unsent) and `[fake:lose:N]` (added in 7.1b: the first N runs of the node are reported cancelled, which is not
termination evidence, so the attempt is "not confirmed ended" and the abandon → Retry path can be exercised). The fake adapter reports complete spend evidence, so its runs settle. E2E specs never use a live
Hermes or tokens.
