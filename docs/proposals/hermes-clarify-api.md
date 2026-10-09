# Proposal: surface Hermes `clarify` questions to API clients

Status: proposal from PLAN 5.25 (2026-10-09). Nothing in Score depends on it yet.

## What Score wants

When an agent calls the `clarify` tool in a Score-started run, the chat should show the question with its choices as
buttons (plus "Other" with a text box) and send the person's answer back to the waiting run.

## What Hermes does today (read from `~/.hermes/hermes-agent`, version in the tested fingerprints)

- `tools/clarify_tool.py` registers the tool. It runs the model's questions through a **callback** the platform passes in
  (`kw.get("callback")`) and blocks on a `human_input_request("clarify", ...)`.
- `tools/clarify_gateway.py` is the gateway-side primitive: `register(clarify_id, session_key, question, choices, ...)`,
  a per-session notify callback, and `resolve_gateway_clarify(clarify_id, response)` /
  `resolve_text_response_for_session(session_key, response)` to answer. Messaging adapters (Telegram, Slack, ...) render
  buttons and call these.
- `gateway/platforms/api_server_runs.py` (the `/v1/runs` API Score uses) wires **approvals** the same way
  (`register_gateway_notify(run.approval_session_key, ...)`, the `approval.request` SSE event and
  `POST /v1/runs/:id/approval`), but has **no clarify wiring**: no clarify callback is passed to the run's agent, no
  `clarify.request` event is emitted, and there is no endpoint that calls `resolve_gateway_clarify`.

So a `clarify` call inside a run started through the API cannot reach the person, and Score has nothing to answer with.
A bridge plugin cannot fill this gap alone: the callback is chosen when the run's agent is built, inside Hermes, and
`resolve_gateway_clarify` is only reachable from inside the gateway process (it holds in-process module state). Hooking
it from `score_bridge` would mean patching Hermes private objects beyond the `hermes_private.py` boundary rules.

## What would be needed in Hermes

Mirror the approval path in `api_server_runs.py`:

1. When a run's agent is built, pass a clarify callback that registers a pending entry (`clarify_gateway.register`) keyed
   by the run's session key and publishes an SSE event, e.g.
   `{ "event": "clarify.request", "request_id": "<clarify_id>", "question": "...", "choices": ["..."], "multi_select": false }`,
   setting the run status to `waiting_for_clarification` (or reusing `waiting_for_approval` with a type field).
2. `POST /v1/runs/:run_id/clarify` with `{ "request_id": "...", "response": "<choice text or free text>" }`, calling
   `resolve_gateway_clarify`, answering `404` for an unknown/expired request and emitting `clarify.responded`.
3. Honour the existing clarify timeout (`resolve_clarify_timeout`) and close pending entries when the run ends or is
   stopped (as approvals are).

## What Score would do once that exists

- Contract: a `clarify` message part `{ kind: 'clarify', requestId, question, choices, multiSelect, answered }` and
  `POST /api/clarifications/:id/answer`; Node adapter (`hermes/live/translate.ts`, `gateway.ts`) translates the event and
  forwards the answer; the card in Chat renders buttons and "Other".
- Fakes and fixtures from a recorded `clarify.request` event.

Until then, the agent's own plain-text question in its reply is the only path, and the run is not blocked by it.
