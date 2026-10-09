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
}

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
| `room.version.created` | `RoomVersion` (a rewind hid the anchor and everything after it; the `message.deleted` events for those messages precede it) | Chat |
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
  `PUT /api/agents/:agentId/model`) and `/compress` (Hermes has no API to compact a session, so it explains that). They
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
  git follows the file; `409 exists`; `413` and nothing moved when a link rewrite would push a note over 2 MiB; links added
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
- Errors: path outside the vault, `..`, NUL, absolute, `.git` → `400 bad_path`; not a `.md` note where one is needed →
  `400 not_a_note`; too large (note > 2 MiB) → `413 payload_too_large`; missing → `404 not_found`.

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

- `GET /bridge/v1/commands?wait=25` (`wait` 0–30) → `{ items: { commandId; kind: 'rewind'; sessionId; turns; since?; expiresAt }[] }` (`expiresAt` = epoch seconds, issued + the 60 s answer
  time; the plugin refuses the command (`expired`) when it is past, checked under the transcript lock immediately before it mutates, so a
  command Score gave up on can't rewind later work; `since` = epoch seconds of the rewound message; the plugin then
  computes the number of turns itself, as every user turn of Hermes's alternation-repaired projection from the first one at or after
  `since`, uses `turns` only as Score's own count, refuses (`failed`) when the message shares a turn with an earlier unanswered
  one or no turn starts at/after `since`, counts, rewinds and verifies under one hold of Hermes's transcript lock (a concurrent `/undo`
  can't move the target; a target that changed is `failed`), and checks afterwards that no active user row from `since` remains, else `failed`). A
  command is handed to one polling producer of the profile once and is not redelivered.
- `POST /bridge/v1/commands/:commandId/result` `{ outcome: 'done' | 'nothing' | 'failed' | 'expired'; turnsUndone?; rewoundCount?;
  error? }` → `204`. For `rewind`, the plugin calls the gateway session store's `rewind_session(sessionId, turns)` (what
  `/undo` uses; soft-deletes the rows, the next turn rebuilds from the active ones) from `hermes_private.py` and reports
  Hermes's `turns_undone` / `rewound_count`; `nothing` = Hermes had nothing to rewind. A command with no result within
  60 s is reported to the person as `no_answer`, and Score keeps the room's rewind hold (persisted in `rewind_holds`, restored after a
  restart) until `expiresAt` + 5 s, when the command can no longer act. The plugin remembers results by `commandId`, so a repeated command never
  rewinds twice.

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
