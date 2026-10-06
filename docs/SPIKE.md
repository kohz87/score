# Spike: what the live Hermes install actually exposes

Date: 2026-10-06. Machine: Ubuntu 26.04.1 LTS, x86_64.
Sections 0 and (a)–(d) were run **read-only**: SQLite opened with `file:…?mode=ro`, secrets redacted.
The **live tests** at the end (L1–L5) were run after the owner approved them, and they changed Hermes config; the
full list of changes is in "What the live tests changed".

Source code was read at the exact commit the live install runs (`e97923c3`, checked out in
`../reference/hermes-agent`, one commit behind upstream `main`).

> **Bottom line**
>
> | Question | Answer | Confidence |
> |---|---|---|
> | (a) Tool calls visible mid-run? | **Yes**, three ways: run SSE (`/v1/runs/{id}/events`), incremental `state.db` flushes after every tool result, and in-process plugin hooks. | **Verified live** (L2, L4) |
> | (b) See and answer a pending approval? | **Yes for runs Score starts** (`approval.request` event → `POST /v1/runs/{id}/approval`). **For other runs** (Telegram, cron, other UIs) only through a Hermes plugin: observe via `pre_approval_request`, answer via an approval *transport* or in-process `resolve_gateway_approval`. **Kanban workers never ask anyone by default**: they auto-deny. | **Verified live** (L2, L4A, L5), including in-process resolution and a scoped Kanban grant |
> | (c) Start a turn for a specific profile from our backend? | **Yes**: `POST /p/{profile}/v1/runs` on the gateway's API server (profile must be served by the gateway), or a Kanban task assigned to that profile, or `hermes -p <profile> chat -q` (no approvals possible). | **Verified live** (L1, L3); needs a per-profile API key |
> | (d) Kanban DB schema? | 7 tables, all **empty**. Full DDL in `docs/spike/kanban-schema.sql`. | Verified live |
>
> **Your install differs from the brief.** It has only the `default` profile (no akeno / fern / makima / marin),
> no plugins (Graphite not found anywhere under `~`), an empty Kanban board, 0 sessions, and the HTTP API
> server is off. It looks like a fresh install from today (all files timestamped 11:47).
> **Owner confirmed (2026-10-06):** only hermes-agent is installed on this machine; Graphite isn't. Rooms and
> @mention hand-offs are built from scratch. Live tests use neutral test profiles (L3).

---

## 0. Install facts

```console
$ hermes --version
Hermes Agent v0.21.5+7904.ge97923c (2026.9.24) · upstream e97923c3
Install directory: /home/raven/.hermes/hermes-agent
Install method: git
Python: 3.14.7
OpenAI SDK: 2.24.0

$ hermes profile list
 Profile          Model                        Gateway      Alias        Distribution
 ◆default         stealth/space-bunny-alpha    running      —            —

$ ls ~/.hermes/plugins          # (empty)
$ ls ~/.hermes/profiles
ls: cannot access '/home/raven/.hermes/profiles': No such file or directory
$ find ~ -iname '*graphite*' -not -path '*/node_modules/*' -not -path '*/reference/*'
/home/raven/.hermes/hermes-agent/contributors/emails/mrgraphitem@gmail.com     # unrelated

$ cat ~/.hermes/gateway_state.json
{"pid":2399,"kind":"hermes-gateway","argv":[".../hermes_cli/main.py","gateway","run"],
 "gateway_state":"running","active_agents":0,"platforms":{},"session_store":{"status":"ok"},
 "code_sha":"e97923c38acba2066aff9c45e35fe1584a2155b2","code_version":"0.21.5",
 "served_profiles":["default"],"active_work":null, ...}

$ hermes config get platforms.api_server
Config key not set: platforms.api_server
$ curl -s -m 2 http://127.0.0.1:8642/v1/health; echo " exit=$?"
 exit=7                                   # connection refused: API server is not listening

$ ls -la ~/.hermes/*.db
-rw-r--r-- 1 raven raven 118784 Oct  6 11:47 /home/raven/.hermes/kanban.db
-rw-r--r-- 1 raven raven 155648 Oct  6 11:47 /home/raven/.hermes/shared-state.db
-rw------- 1 raven raven 282624 Oct  6 11:47 /home/raven/.hermes/state.db
```

Relevant config (from `~/.hermes/config.yaml`, `_config_version: 49`), nothing secret:

```yaml
kanban:
  review_dispatch: true
# security.approval is commented out → defaults apply:
#   approval: { transport: builtin, transport_fallback: deny }
# approvals: (defaults, hermes_cli/config_defaults.py:1666)
#   mode: smart, timeout: 300, cron_mode: deny, single_query_mode: deny, unattended_mode: deny
```

Schema dumps were produced with `docs/spike/schema.py` (opens each DB with `?mode=ro`):

```console
$ python3 -I docs/spike/schema.py ~/.hermes/kanban.db       > docs/spike/kanban-schema.sql
$ python3 -I docs/spike/schema.py ~/.hermes/state.db        > docs/spike/state-schema.sql
$ python3 -I docs/spike/schema.py ~/.hermes/shared-state.db > docs/spike/shared-schema.sql
```

---

## (a) Are tool calls exposed while a run is still in progress?

**Yes, through three independent channels.**

1. **Gateway API server: run event stream (runs we start).**
   `GET /v1/runs/{run_id}/events` is SSE with `id: <seq>` on every frame and `Last-Event-ID` / `?last_seq=` resume
   (`gateway/platforms/api_server_runs.py:1064-1150`). Events include `message.delta`, `message.interim`, `tool.started {tool, preview}`,
   `tool.completed {tool, duration, error, preview≤500 chars, redacted}`, `reasoning.available`, `subagent.start`,
   `subagent.complete` (with tokens and cost), `approval.request`, `approval.responded`, `run.steered`, and terminal
   `run.completed | run.failed | run.cancelled | run.interrupted`. *Correction (review, 2026-10-06):* the Runs API sets
   `queued`/`running` **status** but does not emit `run.queued`/`run.started` **events** (confirmed by the L2
   fixture); lifecycle must come from dispatch + `GET /v1/runs/{id}`. Backlog: 1000 events per run, in memory.
   A `replay.truncated` frame tells the client when it asked for events older than that.
   **Limit:** a run is visible only to the caller that created it (`_request_owns_run`). Runs started by Telegram,
   cron, Kanban workers or other UIs are **not** visible here.

2. **`state.db` incremental persistence (every run, any origin, any process).**
   After each tool result the agent flushes the message list to SQLite *before* projecting it to any UI
   (`agent/tool_executor.py:195-215`, `_flush_session_db_after_tool_progress`: "tool side effects can kill/restart the
   process before turn-end persistence runs"). So `messages` rows with `role='assistant'` + `tool_calls` and
   `role='tool'` results appear mid-run. `sessions.last_activity_at` / `last_activity_description` are refreshed at most
   every 60 s (`agent/session_activity.py:21`). Tool calls become visible when they **complete**, not when they start.
   Streaming text is not persisted until the turn ends.

3. **Plugin hooks (every run, any origin, real time).**
   A Hermes plugin can register `pre_tool_call`, `post_tool_call`, `on_stream_start/delta/end`, `on_interim_message`,
   `subagent_start/stop`, `on_session_start/end`, `pre/post_approval_request|response`, `on_human_input_request/resolved`,
   and `on_kanban_worker_spawned/exited`, `on_kanban_task_updated` (`hermes_cli/plugins.py:110-203`). Plugins load in every
   Hermes process, including Kanban worker subprocesses (the dispatcher passes `--accept-hooks`,
   `hermes_cli/kanban_db_dispatch.py:2750`). This is the only channel that sees *everything live*.

Kanban side: `task_events` (append-only, `id AUTOINCREMENT`, `created_at` integer) and `task_runs` (one row per worker
attempt, `last_heartbeat_at`) are written as tasks move. Hermes itself tails them (`hermes kanban watch` / `tail`).

## (b) How can an external app see and answer a pending approval?

How the approval engine routes a flagged action (`tools/approval.py:793-935`, `tools/approval_prompt.py:200-255`):

```
yolo bypass → session allow-cache → [unattended context? → instant deny/approve per config]
            → selected plugin TRANSPORT (if security.approval.transport != builtin)
            → gateway notify callback (blocks the agent thread until resolved or 300 s timeout)
            → CLI prompt
```

| Origin of the run | What a human sees by default | How Score can see it | How Score can answer it |
|---|---|---|---|
| Run Score started via `/v1/runs` | — | `approval.request` SSE event (command redacted, `choices`) | `POST /v1/runs/{id}/approval {"choice":"once"\|"session"\|"always"\|"deny", "request_id"?}` → `approval.responded` |
| Gateway chat (Telegram etc.) | Prompt in that chat, `/approve` `/deny` | Plugin hook `pre_approval_request(session_key, command, description, pattern_key…)` | (i) In-process `tools.approval.resolve_gateway_approval(session_key, choice, request_id=…)` from a plugin running in the gateway process; additive, first answer wins. (ii) **Or** select a plugin approval transport; this *replaces* the Telegram prompt. |
| Kanban worker (`hermes -p X chat -q …`) | **Nothing.** `-q` sets `HERMES_SINGLE_QUERY_SESSION=1` (`hermes_cli/cli_single_query.py:514`); default `approvals.single_query_mode: deny` blocks the command instantly and the agent looks for another way | Plugin `post_tool_call` sees the blocked result. The agent may `kanban block --kind needs_input` | Not as an approval. Score shows it as "Needs you" and the human unblocks or comments. Changing this needs a config decision (see Decisions). |
| Cron job | Nothing (`cron_mode: deny`) | Same as Kanban | Same |

The plugin approval transport contract (`hermes_cli/approval_transport.py`): the host builds an immutable, **redacted**
`ApprovalRequest{request_id, digest, command, description, pattern_key, surface, timeout_seconds, allowed_choices}`; the
plugin's `present()` must return `ApprovalDecision(request_id, digest, choice)` before the timeout, or the host denies.
Only one transport can be selected, by `security.approval.transport: <name>` in `config.yaml`. The request object
does not carry the session key; the `pre_approval_request` hook fired just before it does (with the same
`request_id`), so a plugin can correlate the two.

Not available: there is no cross-process, on-disk queue of pending approvals. `_pending` in `tools/approval.py:52`
is in-process memory, and the gateway control socket (`~/.hermes/gateway.sock`) answers only `identify`, `status` and
profile-management verbs.

## (c) Can our backend start an agent turn for a specific profile?

Yes, three ways:

1. **Gateway API server, profile-prefixed** (preferred).
   `POST /p/{profile}/v1/runs` with `{"input": "...", "session_id"?: "...", "conversation_history"?: [...],
   "instructions"?: "...", "model"?: "..."}` plus optional `Idempotency-Key` and `X-Hermes-Session-Key` headers →
   `{run_id}` immediately. Then `/events`, `/approval`, `/steer`, `/stop`. The `/p/{profile}` prefix is added for every
   API route (`api_server.py:4515-4519`); unknown or unserved profiles return 404. The gateway must be **serving** that
   profile (`gateway_state.json → served_profiles`; control verbs `serve-profile` / `unserve-profile`).
   Prerequisite: `platforms.api_server.enabled: true` (+ key) in config and a gateway restart. **This writes config,
   so I have not done it.**
2. **Kanban.** `hermes kanban create … --assignee <profile>`; the dispatcher (now inside the gateway) spawns
   `hermes -p <profile> --cli --accept-hooks [--skills …] [-m …] chat -q "work kanban task <id>"`
   (`kanban_db_dispatch.py:2740-2775`). Durable and visible on the board, but no live approvals (see (b)).
3. **One-shot CLI.** `hermes -p <profile> chat -q "…"` from a subprocess. Simple, but approvals auto-deny and
   there is no structured event stream (stdout only). Fallback only.

Also present, not chosen: the dashboard's `/api/ws` JSON-RPC (`tui_gateway`, with `approval.respond`, `prompt.*`,
`session.*`). It is built for one interactive TUI or desktop client, not as a multi-agent backend API.

## (d) Kanban DB schema

`~/.hermes/kanban.db`, WAL mode, `user_version 0`. **All tables are empty.** Full DDL: `docs/spike/kanban-schema.sql`.

| Table | Purpose | Key columns |
|---|---|---|
| `tasks` | Cards | `id TEXT PK`, `title`, `body`, `assignee` (profile), `status`, `priority`, `created_by`, `created_at/started_at/completed_at` (int epoch), `current_run_id`, `session_id`, `block_kind`, `skills` (JSON), `model_override`, `provider_override`, `reasoning_effort`, `goal_mode`, `workflow_template_id`, `current_step_key`, `tenant`, `result`, `completion_contract`, worker pid/claim/heartbeat fields |
| `task_runs` | One row per worker attempt | `id INTEGER PK`, `task_id`, `profile`, `step_key`, `status` (`running\|done\|blocked\|crashed\|timed_out\|failed\|released`), `outcome`, `started_at`, `ended_at`, `last_heartbeat_at`, `summary`, `metadata`, `error` |
| `task_events` | Append-only event log | `id INTEGER PK AUTOINCREMENT`, `task_id`, `run_id`, `kind`, `payload` (JSON text), `created_at` |
| `task_comments` | Comments | `task_id`, `author`, `body`, `created_at` |
| `task_links` | Dependencies | `(parent_id, child_id)` |
| `task_attachments` | Files | `task_id`, `filename`, `stored_path`, … |
| `kanban_notify_subs` | Gateway subscriptions | per task × platform × chat |

Status vocabulary (`hermes_cli/kanban_db.py:106-110`):
`triage, todo, scheduled, ready, running, blocked, review, done, archived`; block kinds
`dependency, needs_input, capability, transient`.

Proposed mapping to Score's columns (the design's five):

| Score column | Kanban statuses |
|---|---|
| Planned | `triage`, `todo`, `scheduled`, `ready` |
| Working | `running` |
| In review | `review` |
| Needs you | `blocked` with `block_kind ∈ {needs_input, capability}` (+ any task whose run has a pending approval) |
| Done | `done` (`archived` hidden by default) |

Writes should go through the `hermes kanban` CLI (create, assign, comment, block, unblock, request-review,
request-changes, complete, archive…), not raw SQL, so claims, the dispatcher and notifications stay consistent.

Other DBs (read-only dumps in `docs/spike/`):
- `state.db`: `sessions` (63 columns incl. `profile_name`, `parent_session_id`, token counts,
  `estimated_cost_usd/actual_cost_usd`, `last_activity_*`, `tool_names`), `messages` (`role`, `content`, `tool_calls`,
  `tool_call_id`, `tool_name`, `timestamp REAL`, reasoning fields, `display_*`, `message_uid`), `session_model_usage`,
  `async_delegations`, … 0 rows.
- `shared-state.db`: `hosted_room*` tables (Hermes's native multi-host rooms), 0 rows.

---


## Live tests (run 2026-10-06 with owner approval)

Scripts and evidence: `docs/spike/run.mjs` (run driver: starts a run, records SSE, samples `state.db`, optionally
answers approvals), `docs/spike/score-spike-plugin/` (throwaway hook logger with two opt-in probes),
`docs/spike/l2-run-events.json`, `l4a-run-events.json`, `l5-worker-hooks.json`, `l5-task-events.json`.
Model for all runs: `poolside/laguna-s-2.1:free` (free tier, **$0 spent**).

### L1: enable the API server ✅
```console
$ umask 077; python3 -I -c 'import secrets;print(secrets.token_urlsafe(32))' > ~/.score/hermes-keys/default
$ hermes config set API_SERVER_KEY "$(cat ~/.score/hermes-keys/default)"
✓ Set API_SERVER_KEY in /home/raven/.hermes/.env
$ hermes gateway restart
✓ User service restarted (PID 12014)
$ curl -s http://127.0.0.1:8642/v1/health
{"status": "ok", "platform": "hermes-agent", "version": "0.21.5"}            # no auth needed
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8642/v1/capabilities
401
$ curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8642/v1/capabilities   # excerpt
"run_submission": true, "run_events_sse": true, "run_stop": true, "run_steer": true,
"run_approval_response": true, "tool_progress_events": true, "approval_events": true,
"session_chat_streaming": true, "skills_api": true,
"admin_config_rw": false, "jobs_admin": false, "memory_write_api": false,
"session_continuity_header": "X-Hermes-Session-Id", "session_key_header": "X-Hermes-Session-Key"
```
Setting `API_SERVER_KEY` alone enables the API server. Config and memory writes are **not** available over HTTP,
so Score uses the `hermes` CLI for those. *Correction (review):* `jobs_admin: false` notwithstanding, the
authenticated `/api/jobs*` routes **are** registered (`api_server.py:1780-1787`); capabilities are not a complete
endpoint inventory, so Score probes endpoints directly.

### L2: one run on the default profile, deny via the Runs API ✅
- **Problem found:** your default model `stealth/space-bunny-alpha` returns `HTTP 404 … not found`, and paid models
  fail with "account balance is too low" (Nous Portal). Every run on `default` currently fails. Per-request
  `"model"` overrides work (the run records the requested model).
- Event order (68 events): `reasoning.available` → `message.interim` → `tool.started {tool, preview: <command>}` →
  `tool.completed {duration, error, preview: <json result ≤500 chars>}` → … → `approval.request` →
  `approval.responded` → `tool.completed {error: true, "BLOCKED: Command denied by user…"}` → `run.completed
  {output, usage}`. `id:` = `seq`, monotonic per run, starting at 0.
- `approval.request` payload: `command` (redacted), `pattern_key`, `pattern_keys`, `description`,
  `allow_permanent`, `allow_session`, `request_id`. `POST /v1/runs/{id}/approval {"choice":"deny","request_id":…}`
  → 200 `{"resolved": 1}` within ~10 ms; the agent stopped as instructed.
- `state.db`: the session row and user message appear at run start. The assistant's `tool_calls` row lands when
  the tool **starts**, and the `tool` result row right after it **completes**. `sessions.last_activity_description`
  stayed `null`. So DB polling trails SSE by about 1 s.
- Cost signal: **51k input tokens** for three one-line commands (large system prompt).

### L3: per-profile runs ✅
```console
$ hermes profile create scoretesta --clone --no-alias --description "Score spike test profile (safe to delete)"
$ hermes profile create scoretestb --clone --no-alias --description "…"
# gateway_state.json → served_profiles: ['default', 'scoretesta', 'scoretestb']   (auto-served, no restart)
$ hermes -p scoretesta config set model.default 'poolside/laguna-s-2.1:free'      # test profiles only
$ curl … /p/nosuchprofile/v1/capabilities → 404 {"error": "Unknown or unconfigured profile"}
$ curl … -H "Bearer <owner key>" /p/scoretesta/v1/runs → 401 gateway_auth_failed
$ hermes -p scoretesta config set API_SERVER_KEY <per-profile key>                 # no restart needed
$ curl … /p/scoretesta/v1/runs → run.completed "hello from scoretesta"
```
- **Each named profile needs its own `API_SERVER_KEY`** (the owner key is refused). `--clone` does not copy it.
  Score keeps one key per profile in `~/.score/hermes-keys/<profile>` (0600).
- Run IDs are scoped per profile: an unprefixed `/v1/runs/{id}` lookup of a profile's run returns 404.
- **Each profile has its own `state.db`** at `~/.hermes/profiles/<name>/state.db`. `kanban.db` is shared
  (`~/.hermes/kanban.db`, `assignee` = profile).

### L4: hooks + approvals alongside other surfaces ✅ (after one adjustment)
Plugin installed into **scoretesta only** (`~/.hermes/profiles/scoretesta/plugins/score-spike/`, then
`hermes -p scoretesta plugins enable score-spike`). The running gateway hot-reloaded it, with no restart.
- Hooks fire in the gateway process for API runs: `on_session_start`, `pre_tool_call` / `post_tool_call`
  (`tool_name`, `args`, `result`, `tool_call_id`, `duration_ms`, `status`), `on_interim_message`,
  `on_human_input_request` / `resolved`, `pre_approval_request` / `post_approval_response`, `on_session_end`.
  For API runs, `session_id` = `session_key` = the `run_…` id.
- First attempt: the **smart approval guardian auto-approved** `rm -rf /tmp/…` (`surface: smart`,
  `choice: smart_approve`, `decided_by: aux_llm`). In L2 the same pattern went to a human, so smart mode is
  nondeterministic. The hooks still fire, so Score can show "auto-approved by guardian".
- With `approvals.mode: manual` on scoretesta: `pre_approval_request {session_key, pattern_key, surface:
  gateway, request_id: None}` → the plugin called `tools.approval.resolve_gateway_approval(session_key, "deny")`
  in-process 1.5 s later → `resolved: 1` → `post_approval_response {choice: deny}` → the agent got "BLOCKED:
  Command denied by user". **Approvals shown alongside other surfaces work.**
- Gotchas: (1) in-process resolution emits **no** `approval.responded` on the run SSE, so Score must use
  `post_approval_response` (or the blocked `tool.completed`) as the resolution signal. (2) On the gateway
  surface the hook's `request_id` is `None`, and the SSE `request_id` differs from the `on_human_input_request`
  `request_id`, so correlation is by `session_key` (plus command text). This is fine for sequential tools and
  ambiguous for parallel tool calls in one session.

### L5: Kanban worker approvals ✅ (the session grant failed; an in-memory allow works)
- Task `t_e8276867` → dispatcher spawned worker pid 14388 (`HERMES_KANBAN_TASK` set, `HERMES_SINGLE_QUERY_SESSION=1`).
  `task_events`: `created → claimed → tip_scratch_workspace → spawned → heartbeat → blocked`.
- The `rm -rf` was denied **instantly**, with **no** `pre_approval_request` hook. It is visible only as
  `post_tool_call.result = {"exit_code": -1, "error": "BLOCKED: Command flagged as dangerous (delete in root
  path) but single-query mode (-q) runs without a user present…", "status": "blocked"}`. There is no structured
  `pattern_key`; the bridge can recompute it with Hermes's own `detect_dangerous_command(command)`.
- **Session grant failed:** `approve_session(get_current_session_key(), pattern)` from `pre_tool_call` had no
  effect, because unattended mode checks only the **permanent** allowlist (`_unattended_deny` →
  `_is_permanently_approved`). A re-block for the same reason sent the task to **triage**, and Hermes's specifier
  re-dispatched it from there (`block_loop_detected`, `specified`, `promoted`). Archived to stop the loop.
- **In-memory allow works:** for a fresh task `t_478c2ed0`, the plugin called `tools.approval.approve_permanent(
  "delete in root path")` **only in the worker whose `HERMES_KANBAN_TASK` matched**. That set is in-memory
  (persisting is a separate `save_permanent_allowlist` step), so the grant lived and died with that worker process.
  The `rm -rf` ran, the task completed, and a concurrent worker for another task was still blocked. No
  `command_allowlist` was written anywhere (checked default and scoretesta configs).

### What the live tests changed (all approved)
| Change | Where | Keep? |
|---|---|---|
| `API_SERVER_KEY` set → API server enabled on 127.0.0.1:8642 | `~/.hermes/.env` | Keep: Score needs it |
| Profiles `scoretesta`, `scoretestb` (cloned from default, free model, own API keys) | `~/.hermes/profiles/` | Keep for development; delete with `hermes profile delete <name>` |
| `approvals.mode: manual` | scoretesta config only | Keep (deterministic tests) |
| Plugin `score-spike` (now **disabled**) | scoretesta plugins | Delete when the real bridge plugin lands |
| Kanban tasks `t_e8276867` (archived), `t_478c2ed0` (done) | `~/.hermes/kanban.db` | Harmless |
| Sessions from test runs | default/test-profile `state.db` | Harmless |
| Score keys `~/.score/hermes-keys/*` (0600, one per profile) | `~/.score/` | Keep |

**Still broken on your side (not caused by the tests):** the default profile's model `stealth/space-bunny-alpha`
doesn't exist anymore, and the Nous Portal balance can't pay for paid models.
