# Draft proposal (not sent): one-shot grants for unattended workers, and request ids in approval hooks

**Status:** draft by Score's lead for the owner. Nothing has been posted to NousResearch. The owner decides whether and
where to propose it (issue or PR on `NousResearch/hermes-agent`).

## Problem

Unattended contexts (`chat -q` Kanban workers, cron, webhooks) deny dangerous commands instantly (`approvals.
single_query_mode: deny`). An operator who sees the blocked command in another UI and wants to allow **exactly that
command, once, in the next attempt** has only two options today: add the pattern to `command_allowlist` (profile-wide,
permanent), or have a plugin add it to the in-memory permanent set around the call. The second can't be made safe from
a plugin:

- `_persist_choice` snapshots the **whole** permanent set into `command_allowlist` when anyone chooses "always", so a
  temporary entry can be persisted;
- `_run_foreground` retries `env.execute()` up to three times beneath the guard, so "once" can mean four executions;
- other `pre_tool_call` plugins can modify the arguments after the granting plugin has checked them;
- hook callbacks run on bounded daemon threads that can be abandoned, and forks copy the set, so cleanup can't be
  guaranteed;
- `tool_call_id` is not unique, so nothing identifies which call owns the grant.

## Proposal 1: opt-in one-shot grants

**Opt-in, off by default.** Nothing changes for installations that don't enable it:

```yaml
approvals:
  unattended_grants: false # default; true enables stage/consume below for this profile
```

With the setting off, `stage_unattended_grant` refuses (raises or returns `None`), and `_unattended_deny` behaves
exactly as today. With it on, a scoped capability that Hermes itself checks and consumes **inside**
`_unattended_deny`, after all argument rewriting:

```python
# tools/approval.py (sketch)
def stage_unattended_grant(*, task_id: str | None, run_id: int | None, command_sha256: str,
                           workdir: str | None, pattern_key: str, expires_at: float) -> str: ...
def revoke_unattended_grant(grant_id: str) -> bool: ...
```

- Stored outside the permanent set (never in `_permanent_set()` or any persistence snapshot), keyed by the worker's
  task and run (`HERMES_KANBAN_TASK` / `HERMES_KANBAN_RUN_ID`), the sha256 of the **final** command after plugin
  rewrites, the effective working directory/backend, and the pattern key.
- Consumed atomically (under `_lock`) the first time `_unattended_deny` would deny a matching command; single use even
  if the terminal tool then retries (the retry loop must not re-consult it, and a grant-allowed execution shouldn't
  retry after a possible launch).
- Expires; never inherited across `fork()`; exposed to observers via a hook such as `on_unattended_grant_consumed(
grant_id, task_id, run_id, tool_call_id, outcome)` so the UI can attribute the execution.
- Delivery from outside the worker process: a Kanban-level mechanism (e.g. a `task_grants` row created by
  `hermes kanban grant --once --command-sha256 … <task>`, read by the next worker at start), so the operator's tool
  never needs to run code inside the worker.

## Proposal 2: the request id in approval hooks

`pre_approval_request` / `post_approval_response` don't carry the gateway queue entry's `request_id`
(`tools/approval_gateway_wait.py`: the payload is built from `approval_data` without it). An observer that wants to
answer through `resolve_gateway_approval(..., request_id=...)` has to guess the id from `list_gateway_approvals`, which is
ambiguous when two identical commands are pending in one session (e.g. terminal approval batching), or when the prompt
is answered on another surface between the enqueue and the hook.

**Change:** add `request_id=entry.data["request_id"]` to the hook payload in `_await_gateway_decision` (and to the
coalesced follower's hooks, plus `leader_request_id`), so `pre_approval_request` and its matching
`post_approval_response` name the exact entry. It's additive: existing hook callbacks that accept `**kwargs` keep
working, and narrow-signature callbacks are already filtered by `_hook_callback_kwargs`. The same applies to the
transport path (it already passes `request_id`) and the CLI path (which has no queue entry; omit it there).

Score would then report exact targets for every gateway prompt and drop its "exactly one matching entry" heuristic
(ARCHITECTURE D4.2, known limit).

## What Score would do with it

"Approve once" on a blocked Kanban card → `hermes kanban grant --once …` + `hermes kanban unblock --reason …`;
the next worker consumes the grant inside Hermes's own guard (only where the profile opted in). Until then Score
shows these cards view-only, with Deny and Unblock-with-a-note (ARCHITECTURE D4.3). With proposal 2, gateway approvals
become exact in every case.
