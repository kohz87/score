# Score architecture

Status: **v0.2. Revised after the adversarial review** (`docs/reviews/2026-10-06-architecture-adversarial.md`;
responses in the "Review log" at the end). Owner decisions recorded inline (D4.2, D4.3, D7.1).
Inputs: `docs/SPIKE.md` (what Hermes v0.21 exposes, incl. live tests) and `docs/REFERENCE-NOTES.md`.

## 1. Shape

Your default preference holds, with **one push-back**: we need a small amount of Python, but as a **Hermes
plugin** that runs inside Hermes's own processes, not as a separate sidecar service. Reason: the only way to see
_every_ agent's tool calls and approvals live (including Telegram, cron and Kanban-worker runs), and to act on
gateway approvals precisely, is Hermes's in-process plugin hooks and approval queue (SPIKE L4/L5). Node cannot
reach those, and neither could a sidecar, since it would be a different process.

```
 Browser (apps/web, React SPA)
   │  REST  /api/*        (commands + snapshots; human decisions need the paired session, D7)
   │  SSE   /api/stream   (ONE stream for every screen; resumable; per-query watermarks, D1)
   ▼
 Score server (apps/server, Node 24 + Fastify)                     ~/.score/score.db (Score-owned state, D5)
   ├─ http/        routes = API-CONTRACT.md, nothing else
   ├─ hub/         single ordered ingest path: dedupe → projections → event log, one transaction (D1)
   ├─ domain/      rooms, routing, approvals ledger + delivery outbox, grants, briefs, reports
   └─ hermes/      ◄── ADAPTER BOUNDARY #1 (TypeScript): the only Node code that knows Hermes exists
        ├─ gateway.ts    /p/{profile}/v1/runs (+events, approval, steer, stop), /api/jobs, capabilities
        ├─ kanban.ts     read kanban.db (read-only) · write via `hermes kanban …` with idempotency keys
        ├─ sessions.ts   read per-profile state.db (read-only) · ID checkpoints + reconciliation (D2.4)
        ├─ profiles.ts   read profile dirs · SOUL.md/AGENTS.md atomic writes (D2.6) · other writes via CLI
        ├─ bridge.ts     producer registry, event ingest, decision delivery leases, grant redemption (D4)
        ├─ translate.ts  upstream shapes → Score domain events, keyed by compatibility fingerprint (D2.2)
        └─ fake/         scripted fake Hermes for dev, tests and e2e (no tokens)
   ▲                ▲                                   ▲
   │ HTTP+SSE       │ read-only SQLite + CLI            │ HTTP (events, decisions, grants), spool on failure
 Hermes gateway   ~/.hermes/{kanban.db, state.db}       Score bridge plugin  ◄── ADAPTER BOUNDARY #2 (Python)
 (API server on)  ~/.hermes/profiles/<p>/state.db       hermes-plugin/score_bridge; the only code that calls
                                                         private Hermes functions (score_bridge/hermes_private.py)
```

Repo layout:

```
apps/web/            React 19 + Vite + TypeScript SPA
apps/server/         Fastify server + TypeScript Hermes adapter
packages/contract/   zod schemas + TS types for every endpoint and event (checked against API-CONTRACT.md)
hermes-plugin/       score_bridge Python plugin + pytest (managed with uv)
e2e/                 Playwright tests (fake adapter)
scripts/             license check, codex-task.sh
docs/
```

## 2. Key decisions

### D1. One live stream: SSE with a fenced, transactional event log

**Transport.** One-way server → browser over SSE; every command is a REST request. One stream per tab.

**Single ordered ingest path.** Every producer (run SSE readers, bridge ingest, SQLite tailers, Score's own
domain actions) submits _observations_ to one in-process ingest queue, drained by **one writer**. Each
observation is applied in **one SQLite transaction** that:

1. checks the ingest key (unique `(source, source_identity)`, see D2.3) and drops duplicates;
2. updates the **projections** the screens read (D5);
3. appends zero or more domain events to `events` (`seq INTEGER PRIMARY KEY AUTOINCREMENT`);
4. advances that source's ingestion checkpoint.

`seq` is **strictly increasing**. Gaps are allowed and clients must not assume gap-free. A durable event and the
projection change it describes commit together.

**Snapshots.** Snapshot endpoints read the projection rows **and** `max(seq)` in **one read transaction**
(WAL snapshot isolation), so `asOfSeq` exactly describes the snapshot. Direct Hermes reads never feed live
snapshots; they feed reconciliation (D2.4), which goes through the same ingest path.

**Subscription fence.** On connect: register the subscriber with a buffer → capture head `H` → replay
`(since, H]` from the log → release buffered events with `seq > H` → live. Nothing is lost between replay and
live, and nothing is sent twice.

**Frames.** Durable events carry `id: <seq>`. Control frames (`stream.hello`, `stream.reset`, heartbeats) carry
**no `id`**. `stream.hello` includes the log **epoch** (a random ID stored in `score.db`, regenerated on restore
or reset). On connect the server answers `stream.reset` instead of replaying when:

- the cursor's epoch differs from the current one,
- the cursor is older than the retention floor, or
- the cursor is ahead of the head.

**Client resync (per query, not per tab).** Each cached query records its own `asOfSeq`. While a query refetches,
the client buffers stream events. When the fresh snapshot arrives it replaces the cache, then applies buffered
events with `seq > asOfSeq` for that query. Stale in-flight fetches are cancelled or ignored by request
generation. On `stream.reset` every active query enters this resync.

**Backpressure.** Per-client byte budget plus a socket write timeout. Exceeding either closes the connection; it
does not block the hub. The client reconnects with `Last-Event-ID`. A reset frame is best effort.

**Retention.** The event log keeps 7 days. Reports and history read durable tables (D5), never the log.

### D2. The Hermes adapter boundary

**D2.1 Two explicit boundaries.** (1) `apps/server/src/hermes/` for Node. Lint (`no-restricted-imports`) blocks
imports of its internals, and a test asserts that no other server module mentions Hermes paths, URLs, CLI verbs
or upstream event names. (2) The Python bridge `hermes-plugin/score_bridge/`. Every call into private Hermes
functions (`list_gateway_approvals`, `register_gateway_settle`, `resolve_gateway_approval`,
`approve_permanent`, the permanent-set discard, `detect_dangerous_command`, `redact_sensitive_text`) lives in
**`hermes_private.py`** and nowhere else. `HermesPort` has `live` and `fake` implementations.

**D2.2 Compatibility gate (fingerprints, not semver).** All of Hermes 0.x shares major 0, so semver can't gate
anything. A **compatibility fingerprint** is: Hermes `code_version` + `code_sha` (from `gateway_state.json`),
`/v1/capabilities` features, a hash of the `kanban.db` / `state.db` schemas, the bridge handshake (plugin version,
`plugins.isolation` mode, which private functions resolved), and the CLI version. Score keeps a list of
**tested fingerprints** (recorded with fixtures). If the fingerprint is unknown, Score runs in a degraded mode:

- reads still work;
- Score-started runs are still controlled through the public Runs API;
- bridge-dependent actions (gateway approval answers, Kanban grants) are **disabled** and shown as such;
- a banner explains it.

Under `plugins.isolation: host` the bridge runs outside the gateway process, so in-process approval actions are
impossible. The handshake reports it and those features stay off. `translate.ts` is keyed by fingerprint.
Capabilities are not a complete inventory (e.g. `/api/jobs` exists despite `jobs_admin: false`), so endpoints are
also probed directly.

**D2.3 Canonical producers and stable identities.**

| Domain fact               | Canonical source                                     | Others (enrich/reconcile only)                                         | Stable identity                                          |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| Tool call lifecycle       | Bridge `pre/post_tool_call` (`tool_call_id`)         | `state.db` rows (`tool_call_id`), run SSE `tool.*` (no `tool_call_id`) | `(profile, session_id, tool_call_id)`                    |
| Score-started run status  | Runs API (`GET /v1/runs/{id}` + SSE terminal events) | bridge session hooks                                                   | Hermes `run_id`                                          |
| Run text/reasoning stream | run SSE `message.*` / `reasoning.available`          | bridge `on_interim_message`                                            | `(run_id, seq)`                                          |
| Approval (Score run)      | run SSE `approval.request` (has `request_id`)        | bridge approval hooks                                                  | `(profile, session_key, request_id)`                     |
| Approval (gateway)        | bridge (exact `request_id`, D4)                      | —                                                                      | `(profile, session_key, request_id)`                     |
| Kanban task state         | `kanban.db` `tasks` + `task_events` (append-only)    | bridge `on_kanban_*`                                                   | `task_events.id`, `task_runs.id`                         |
| Session messages          | `state.db` `messages`                                | bridge                                                                 | `(profile, db_incarnation, messages.id)` + `message_uid` |

**Observation identity ≠ entity identity** (from the 1.4a review). The ingest key `(source, identity)` names one
immutable _observation_, not the entity it's about. Each source namespaces its keys by kind, so different tables can
never collide:

- Immutable redeliveries use the upstream event's own ID: `task_event:<id>`, `sse:<run_id>:<seq>`,
  `bridge:<incarnation>:<counter>`.
- Observations of **mutable** state add a revision: `task_run:<id>@<status>:<ended_at>`,
  `message:<uid>@<active>:<compacted>`, `run_status:<run_id>@<status>`. A changed entity therefore produces a new
  observation, not a dropped duplicate.

Projections key on the entity ID. Their `versionColumn` guard (`guardedUpsert`) rejects stale writes. A producer
that sees a conflicting payload for an immutable key logs it as a source fault; it doesn't overwrite.

Bridge events carry `(producer_incarnation, counter)`; the unique ingest key makes re-delivery harmless.
**Terminal-state guards:** a delayed observation can't move a finished run, approval or tool call back to an
earlier state. Upstream cursors are persisted per source: SSE `seq` per run, `task_events.id`, `messages.id` per
DB incarnation, bridge counters per producer.

**D2.4 Recovery per source.**

- **Run SSE**: resume with `Last-Event-ID`. On `replay.truncated` or a gateway restart, poll `GET /v1/runs/{id}`,
  reconcile tools and messages from `state.db`, and record a visible **gap interval** on the run.
  `run.queued`/`run.started` are **not** emitted by the Runs API, so lifecycle starts from Score's own dispatch
  record plus status polling.
- **Bridge**: a bounded on-disk **spool** per producer (`~/.score/spool/`, size-capped, oldest dropped, with a
  drop counter) when Score is unreachable. It drains on reconnect, and dropped ranges become gap intervals.
- **kanban.db**: tail `task_events` by `id` (append-only). Re-read `tasks` rows touched by new events.
- **state.db** (per profile): ingest new rows by `messages.id` > checkpoint, scoped to a DB incarnation
  (file identity + `state_meta`). Hermes inserts carried/cloned rows with **older timestamps** and orders by ID,
  so timestamps are never a cursor. Edits, `active`/`compacted` flips, rewinds and compaction create or change rows
  without new IDs, so a periodic **session reconciliation** compares logical identities (`message_uid`,
  `tool_call_uid`) for sessions active in the last N hours. Fixtures cover rewind, compaction, carried timestamps
  and restore.

**D2.5 Per-profile wiring and credentials.** Every profile has its own `state.db` and its own `API_SERVER_KEY`
(SPIKE L3). Score stores keys in `~/.score/hermes-keys/<profile>` (0600) with a **credential generation**. Run
mappings record the generation they were admitted under, because Hermes scopes run ownership by profile + key.

- **Adoption** of an existing profile is explicit (owner action).
- **Rotation** = stop new admissions for that profile → drain its runs and approvals → rekey → bump the generation.
- A **missing key** marks the profile "credentials unavailable" and is never silently regenerated. Runs admitted
  under a lost key are uncontrollable, and the UI says so.

**D2.6 Writes.** Hermes SQLite is never written.

- **CLI or gateway API** (`execFile`, argument arrays, timeouts, parsed output) for Kanban, config, profiles,
  skills and cron. Every Hermes-side create goes through a **command intent** (outbox, D5) with a stable
  idempotency key (`Idempotency-Key` on `/v1/runs`, `--idempotency-key` on `kanban create`). After a crash, Score
  reconciles acceptance before retrying or attaching results.
- **Exception: `SOUL.md` and `AGENTS.md`** in a profile directory. No CLI command edits them (`hermes profile`
  has none). The adapter writes exactly these two files: path-checked inside `<profile home>`, etag = sha256 of the
  current content, write temp + fsync + rename. Never `.env`, `auth.json`, `config.yaml` or anything else.

**D2.7 Provider sign-in from the browser (owner request, 2026-10-08).** Score still never _reads_ a credential store
and never _keeps_ a credential, but it may now relay one the person types, so providers can be connected without a
terminal on the Hermes machine.

- **Device-code sign-in** (providers whose `hermes auth add <id> --no-browser` prints a verification link and a user
  code): Score runs that command detached (no controlling terminal, stdin closed), parses only the `https` link and the
  code, shows them, and watches the process until it exits; success is confirmed by re-reading `hermes auth list`. The
  tokens go from the provider to Hermes; Score never sees them. One sign-in per provider at a time; cancelled after 15
  minutes or on request (the process is killed by its handle). Safe over plain-HTTP remote: only a short-lived code crosses
  the network, and approving it signs in the Hermes machine, not the viewer.
- **API key paste**: `POST …/providers/:id/key` runs `hermes auth add <id> --type api-key --label <label>` in a new
  session without a controlling terminal, writing the key to **stdin** (getpass falls back to stdin), never to argv or
  the environment. The key is validated (printable, no whitespace, 8–512 chars), held only in the request handler, and
  never stored, logged, put in an idempotency receipt, a stream event or an error message (the receipt for this route
  keys on the Idempotency-Key and route only). Allowed on loopback and TLS; over plain-HTTP remote mode only with an
  explicit per-request acknowledgement after a warning (the key crosses the LAN unencrypted).
- Interactive flows that need a localhost redirect on the Hermes machine (PKCE callbacks) stay "run in a terminal".

### D3. Starting agent work

| Intent                                 | Mechanism                                                                                              | Canonical live events  | Approvals                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------- | ---------------------------- |
| Chat message to agent(s) in a room     | `POST /p/{profile}/v1/runs` (D3.1)                                                                     | run SSE + bridge       | Runs API (D4.1)              |
| `/assign`, New task, durable hand-offs | `hermes kanban create --idempotency-key …`                                                             | bridge + `task_events` | blocked-worker grants (D4.3) |
| `/routine`                             | `/api/jobs` or `hermes cron`                                                                           | bridge                 | none (cron denies)           |
| Pause / stop                           | `/v1/runs/{id}/stop`; "Pause everyone" = stop Score-started runs + hold Score dispatch; Kanban `block` | —                      | —                            |

**D3.1 Room turns.** Identities are kept separate and persisted per turn:

- `score_turn_id`, Score's own; also the `Idempotency-Key`;
- Hermes `run_id`, which is also the approval session key;
- the conversation session ID, stable per (room, agent): `score-<room>-<agent>`;
- the **live tip** Hermes resolves it to after compression, recorded from run status.

Turns are **serialized per (room, agent)**, so the same agent never runs two turns in one room at once. The input
is built **at admission**, not at enqueue: `session_id` plus, as `input`, the room messages since that agent's
last turn (speaker-labelled). No `conversation_history` is sent, so Hermes keeps the agent's own tool history from
its session and won't swap in a different history after waiting on its turn lease.

**D3.2 @mention routing** (designed from scratch; no Graphite on this machine):

- An unaddressed message goes to the room's lead agent; `@agent` starts a turn for that agent.
- An agent reply that @mentions another agent is a hand-off, subject to a hop limit (6 per human message) and a
  ping-pong guard (a pair at most 2 times without a human message).

### D4. Approvals: one ledger, exact targets, confirmed delivery

**Ledger model.** An _operation_ (one flagged action) has phases: `guardian_evaluating` → `human_pending` →
`decided`. It ends in `executed` or `blocked`.

- Only `human_pending` items with an **actionable exact target** appear in "Needs you".
- Guardian evaluations are recorded (`surface: smart`). An escalation links the later human prompt to the same
  operation. Guardian approve/deny is attributed to the guardian.
- **Decision delivery** is separate from the approval's status: `intent → delivering → applied | not_pending |
failed | unknown`, stored in an **outbox** before any external call.
  - `not_pending` is **never** interpreted as a denial. Score reconciles via hooks/tool results and shows "answered
    elsewhere".
  - "You (Score)" is shown only when delivery is confirmed `applied`. Answers from other surfaces show as
    "answered elsewhere", because Hermes's hooks carry no actor.

**D4.1 Score-started runs.**

- **Canonical:** `approval.request` from that run's SSE, which carries `request_id`.
- **Resolve:** `POST /p/{profile}/v1/runs/{run_id}/approval {choice, request_id}`, using the credential generation
  the run was admitted under.
- **Dedupe:** bridge hooks for the same `session_key = run_id` enrich the same operation.

**D4.2 Gateway sessions (Telegram etc.). Additive, alongside Telegram (owner decision).**

- **Exact target.** In `pre_approval_request` the bridge may read the `request_id` with
  `list_gateway_approvals(session_key)`, but the newest matching entry is **not** proof of ownership (another thread
  can enqueue an identical command between this thread's enqueue and its hook; 1.14b design review, finding 2). The
  bridge reports a `requestId` only when it can prove the entry is this hook's own (e.g. exactly one entry with that
  command and pattern keys); otherwise `null` and the card is view-only.
  **Known limit (1.13b review, finding 1):** Hermes gives a hook no handle to its own queue entry. If a prompt is
  answered on another surface in the milliseconds between its enqueue and its hook (only a FIFO `/approve` or
  `/approve all` can do that, since nobody has seen it yet), while a byte-identical command in the same session is
  queued by a terminal batch, the hook can claim the identical entry. Its own post hook closes that card within
  milliseconds, and any binding is to an identical command. Claims are never evicted and end at the gate's post hook.
  Exact ownership needs Hermes to pass `request_id` to `pre_approval_request` (upstream change; worth proposing).
  ~~The bridge also registers `register_gateway_settle(…)`~~ **Removed (1.14b design review, finding 9):** the settle
  slot holds one callback per request and the gateway registers its own afterwards, so Score must not use it. Resolution
  is observed through `post_approval_response`. The plugin reports a `request_id` only when the queue entry is provably
  this hook's own (identical concurrent commands → `null`, view-only).
- **Resolve:** decisions are delivered **only to the producer that reported the request** (lease plus
  exact-target ack), which calls `resolve_gateway_approval(session_key, choice, request_id=<exact>)`. **No FIFO
  resolution ever:** if no exact `request_id` was captured, the card is view-only ("answer in Telegram").
- **Coalesced followers** (`coalesced=True`) attach to their leader and are never separate actionable cards.

**D4.3 Blocked Kanban workers (owner decisions: a blocked worker becomes an approval, 2026-10-06; view-only until
Hermes offers a one-shot grant, 2026-10-07).**

- **Detection.** In unattended (`-q`) mode Hermes denies a dangerous terminal command instantly, with no approval hooks.
  The bridge's `post_tool_call` decodes the tool result JSON (envelope `status: error`; the decoded `result` has
  `status: blocked` and an `error` starting `BLOCKED: Command flagged as dangerous`; the terminal denial drops
  `pattern_key`), recomputes the pattern with Hermes's `detect_dangerous_command` on the raw command, and reports a
  verified `kanbanDenial` with the command digest. Other blocks (Tirith, `execute_code`) stay diagnostics.
- **What Score shows.** A view-only "Needs you" card linked to the task, with the exact blocked command and why. The
  human acts through Hermes's own state machine: **Deny** = `hermes kanban comment` (the task stays blocked);
  **Unblock with a note** = `hermes kanban unblock --reason` (the next attempt runs unattended again and will block
  again unless the pattern is allowed); **Always allow this pattern** comes with Settings (Phase 2), as an explicit
  `command_allowlist` change after a diff preview.
- **Why no "approve once" (1.13c design review, docs/reviews/2026-10-07-1.13c-design-adversarial.md).** A plugin can only
  grant by adding to Hermes's in-memory permanent allowlist, and that cannot be made one-shot: Hermes's
  `_persist_choice` snapshots the **whole** set into `command_allowlist` whenever anyone chooses "always"; the terminal
  tool retries `env.execute()` up to 3 times beneath the guard; other plugins can rewrite a call's arguments after
  Score's hook; abandoned hook threads and forks defeat cleanup; `tool_call_id` doesn't identify ownership. A safe
  version needs Hermes to consume a scoped, expiring, one-shot capability inside its own guard (draft proposal:
  `docs/proposals/hermes-one-shot-unattended-grant.md`). Score adds "Approve once" only on top of such an API.

**D4.4 Correlation (1.14b design reviews, 2026-10-07).** Ledger rows are keyed only by exact identifiers:
`request_id` (run SSE; a hook's `requestId` when the producer guarantees it), a transport's own request id, and a
**producer-minted gate id**. A gate's pre and post hooks always fire sequentially in the same thread, so the plugin
mints `gateId` at the pre hook and attaches it to that thread's post hook, and reports `linkedGateId` when a human
prompt follows a guardian gate in the same thread. Hermes's `tool_call_id` is not unique (fallback ids repeat for
identical calls, provider ids repeat across completions, subagents share processes), so it is informational only.
There is no matching by pattern, command text or time window, and no "only open one" fallback. A guardian stage and
the human stage it escalates into are **separate rows linked by `linkedTo`** (`escalated`), never merged. Signals that
match nothing are kept and replayed when a row gains their key, so arrival order doesn't matter. Hook stages of
Score-started runs without an exact `requestId` are kept as hidden stage records (the run SSE row is the card).
Coalesced followers are view-only. Decision and completion evidence are stored separately and the phase is recomputed
from them, so a known choice refines a closure regardless of arrival order.
**Tool completion (Phase 1 gate review, finding 3):** Hermes runs `pre_tool_call`/`post_tool_call` on bounded worker
threads with a copied context, while approval hooks run on the caller's thread, and `tool_call_id` isn't unique, so a
tool's completion can't be tied to its approval exactly. Bridge-observed approvals therefore end at `decided` (never
`executed`/`blocked`). The server matches completions only by exact gate ids, which no producer sends until Hermes
offers an exact invocation id.

**"Needs you"** = actionable approvals (D4.1–D4.3) + tasks blocked as `needs_input` (questions).

### D5. Score-owned state (`~/.score/score.db`, node:sqlite, forward-only SQL migrations)

**Infrastructure:**

- `events`: the stream log, with `epoch`.
- `ingest_keys`: unique source identities.
- `ingest_checkpoints`: per source, DB incarnation, run and producer.
- `producers`: bridge identity, incarnation, profile, isolation mode, last seen.
- `gaps`: unrecoverable intervals.
- `command_intents`: outbox for Hermes-side creates and actions.

**Projections** (what live screens read; updated in the same transaction as events):

- `agents_proj`
- `tasks_proj` (Kanban mirror plus Score columns)
- `runs`: **all origins**; `score_turn_id`, `run_id`, profile, credential generation, conversation session,
  live tip, room/task links, status, tokens, cost.
- `tool_calls`
- `lanes` / `handoffs` (Score timeline)

**Owned state:**

- `rooms`, `room_members`, `messages`, `mentions`
- `briefs`, `brief_tasks`, `room_tasks`: the associations Hermes can't hold.
- `approvals` (operations) and `approval_deliveries` (outbox)
- `kanban_grants`
- `agent_style`
- `watch_frames`, `media`
- `settings`, `credentials` (profile → key file + generation; never the key itself)

Reports read `runs`, `tool_calls`, `approvals` and `tasks_proj` history, kept ≥ 90 days.

### D6. Watch = event replay, not remote desktop

- Frames come from the bridge's `pre/post_tool_call` (terminal command + output tail, file path + unified diff from
  patch/write args, browser screenshots or artifact refs) and from interim/reasoning text. They are stored per
  session in `watch_frames` (64 KB per terminal chunk; images in `~/.score/media/` with a quota). Scrub = `seq` order.
- **Mandatory redaction (two layers).** Hermes hooks pass **raw** args and results (`model_tools.py:680`), and
  gateway approval text is redacted only if the user hasn't disabled redaction. So:
  1. the bridge runs `redact_sensitive_text(…, force=True)` on every command, argument and result **before
     truncation and before serialization**;
  2. the server runs its own secret-pattern pass before durable storage.

  Correlation uses digests computed in the plugin on raw text, never stored raw text. Fixtures include
  secret-bearing commands and outputs for every producer.

- "Take control" is **out of scope for v1**. v1 offers "Pause <agent>" and "Open in terminal" (copies the
  `hermes -p … --resume` command).

### D7. Security posture (single user, local first)

- **Network.** The server binds `127.0.0.1`.
- **Browser.** Mutations require `X-Score-Client` + same-origin (CSRF).
- **D7.2 Remote access (task 3.13, opt-in).** Local mode is the default and refuses a non-loopback `SCORE_HOST`.
  `SCORE_REMOTE=1` enables a browser listener on a numeric address (wildcards also need `SCORE_REMOTE_ANY=1`) plus a
  separate loopback-only HTTP listener (`SCORE_BRIDGE_PORT`, default 8740) that alone carries `/bridge/*`. Remote mode
  denies by default with an exact public list (API-CONTRACT §3), serves the built web app from Fastify, checks Host
  and Origin against `SCORE_PUBLIC_ORIGINS` (no proxy trust), and uses server-enforced idle/absolute session expiry,
  bounded pairing attempts, a consent step on the pair page, and revocation that closes open streams. Transport is
  HTTPS only (5.18, owner 2026-10-09): `SCORE_TLS_CERT`/`SCORE_TLS_KEY`, or the certificate `scripts/score tls` makes in
  `$SCORE_HOME/tls`. The browser port peeks the first byte of each connection and sends plain HTTP to a tiny handler that
  serves only the HTTPS setup guide (`/setup/https`, `426 https_required` under `/api`, `308` elsewhere). Without a
  certificate Score starts in guide-only mode and serves nothing else. `SCORE_REMOTE_INSECURE_HTTP` was removed.
  Remote mode never touches Hermes configuration, keys, plugins or gateways.
- **D7.1 Human decisions** (approval decisions, grants, rule changes, credential actions) additionally require a
  **paired browser session**. On first run the server prints a one-time pairing URL **to its own terminal**. The
  browser exchanges it for an HttpOnly, SameSite=Strict session cookie. The server stores only a hash, never in a
  file the bridge uses.
  - **Threat-model limit (owner decision 2026-10-06: accepted, option a):** agents run as the same OS user, so a determined agent with
    shell access could still read browser cookie stores or `~/.score`. Pairing stops casual or accidental
    self-approval and CSRF, not a hostile same-user process.
  - Real isolation means running agents in Hermes's sandboxed terminal backend (docker/ssh) or as a different
    OS user. Score shows the current isolation level on the Settings page.
- **Bridge identity.** The bootstrap secret `~/.score/bridge.token` only allows `POST /bridge/v1/hello`. Each
  producer then gets a short-lived **producer token** scoped to its profile, process incarnation and
  `HERMES_KANBAN_TASK`. It can post only its own events, receive only decisions targeted at its own approvals,
  and redeem only grants for its own task. Bridge tokens can't call `/api/*`.
- **Secrets.** Score never reads `~/.hermes/.env`, `auth.json` or key files. Payloads are redacted per D6.

### D8. Front end

- React 19 + Vite + TypeScript, React Router, TanStack Query. One `useStream()` hook implements D1's per-query
  resync and patches the Query cache. No global state library.
- Design tokens as CSS custom properties, from `docs/design/html/`. Fonts via `@fontsource`, bundled.
  Agents are always shown with color **and** shape.
- Flow: custom SVG, layered auto-layout (seeded from Studio's Kahn layering), pan/zoom/fit. Charts: hand-rolled SVG.

### D9. Shipping defaults

Neutral example agents only: `lead` (violet, circle-dot), `builder` (jade, triangle), `reviewer` (saffron,
diamond), `designer` (coral, square). Persona names live only in the user's local Hermes profiles and in
`~/.score`. The design PNGs stay reference-only.

## 3. Alternatives considered

| Option                                                       | Why not (for v1)                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| WebSocket for everything                                     | Needs our own resume/ack protocol; SSE + REST covers it                                   |
| Python sidecar service                                       | Can't reach in-process hooks or the approval queue                                        |
| Exclusive approval transport (`security.approval.transport`) | Replaces Telegram prompts. The owner chose additive; switching needs a new owner decision |
| Writing kanban.db directly                                   | Bypasses claims, dispatcher and notify; schema is internal                                |
| Hermes dashboard API as backend                              | Separate process with its own auth; may replace D2.6's file writes later                  |
| Studio's browser-run DAG                                     | Superseded by Kanban dependencies + dispatcher                                            |
| Mirroring rooms into Hermes `hosted_rooms`                   | Multi-host feature with grants; revisit after v1                                          |

## 4. Risks

| Risk                                      | Mitigation                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Private Hermes functions change           | Confined to `hermes_private.py`; fingerprint gate disables dependent features; upgrade drill re-runs L4–L6 fixtures |
| Kanban one-shot grant ordering assumption | Live test L6 before shipping D4.3; feature-flagged until then                                                       |
| Same-user agent abuses Score's API        | Pairing (D7.1) + documented limit; recommend sandboxed terminal backend                                             |
| Missed events while Score is down         | Spool, cursors, reconciliation, visible gap intervals (D2.4)                                                        |
| `node:sqlite` stability on Node 24        | Wrapped in `db/`; `better-sqlite3` (MIT) is a drop-in fallback                                                      |

## Review log

### 2026-10-06: Codex adversarial review (gpt-6.1-sol, max)

Full text: `docs/reviews/2026-10-06-architecture-adversarial.md`. I verified each claim against Hermes `e97923c3`
before acting. #1, #9, #10 and #17 were confirmed directly in source; the rest are design gaps.

| #   | Finding                                         | Response                                                                                                                                                            |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | FIFO resolution can approve a different request | **Accepted.** Exact `request_id` via `list_gateway_approvals` + settle callback; no FIFO ever (D4.2)                                                                |
| 2   | `approve_permanent` grants for the whole worker | **Accepted.** Digest-bound, one tool call, in-flight guard, add/remove around the call; L6 test (D4.3)                                                              |
| 3   | No human-only authority                         | **Accepted in part.** Paired session + scoped bridge tokens; full isolation from same-user agents isn't achievable in-app; threat model is an owner decision (D7.1) |
| 4   | Hook payloads aren't redacted                   | **Accepted.** Two-layer mandatory redaction, digests for correlation (D6)                                                                                           |
| 5   | `asOfSeq` not a consistent snapshot             | **Accepted.** Score projections + one read transaction (D1, D5)                                                                                                     |
| 6   | Replay/subscription race                        | **Accepted.** Single writer + subscription fence (D1)                                                                                                               |
| 7   | Duplicates/inversions across channels           | **Accepted.** Canonical producers, stable identities, ingest keys, terminal guards (D2.3)                                                                           |
| 8   | Reset/resync loses changes                      | **Accepted.** Per-query watermarks, buffered resync, epoch, control frames without IDs (D1)                                                                         |
| 9   | Wrong tail cursor; messages mutable             | **Accepted** (confirmed: Hermes orders by ID, carried rows keep old timestamps). ID checkpoints + reconciliation (D2.4)                                             |
| 10  | Unrecoverable events; no `run.started`          | **Accepted** (confirmed). Per-source recovery, spool, gap intervals; SPIKE corrected (D2.4)                                                                         |
| 11  | Decision routing and grant delivery undefined   | **Accepted.** Producer registry, leases, exact-target acks, grant redemption endpoint (D4, contract §11)                                                            |
| 12  | Ledger vs effect idempotency                    | **Accepted.** Delivery outbox and states; `not_pending` ≠ deny (D4)                                                                                                 |
| 13  | Stale grants, triage                            | **Accepted.** Staging, revalidation, attempt binding, expiry, triage handling (D4.3)                                                                                |
| 14  | Wrong status layer in detector                  | **Accepted.** Decode nested result; restrict to verified denial class (D4.3)                                                                                        |
| 15  | Room session identities and concurrency         | **Accepted.** Separate IDs, per-pair serialization, input built at admission (D3.1)                                                                                 |
| 16  | D5 omits non-reconstructible state              | **Accepted.** Briefs, associations, all-origin runs, outbox, checkpoints (D5)                                                                                       |
| 17  | Version gate too weak; host isolation           | **Accepted** (confirmed). Fingerprint gate, bridge handshake, second boundary (D2.1, D2.2)                                                                          |
| 18  | No profile-file write mechanism                 | **Accepted.** Scoped atomic writes for SOUL.md/AGENTS.md only (D2.6)                                                                                                |
| 19  | Key rotation orphans runs                       | **Accepted.** Credential generations, adoption, drain-then-rotate (D2.5)                                                                                            |
| 20  | Guardian phases and attribution                 | **Accepted.** Operation phases; attribution only on confirmed delivery (D4)                                                                                         |

Rejected findings: none.
