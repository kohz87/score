"""Score spike plugin (throwaway). Logs hook payloads; two opt-in probes gated by files in ~/.score."""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

_LOG = Path.home() / ".score" / "spike-hooks.jsonl"
_DECISION = Path.home() / ".score" / "spike-decision"   # contains once|deny → resolve in-process
_GRANT = Path.home() / ".score" / "spike-grant"         # contains a pattern_key → approve_session pre-grant
_lock = threading.Lock()


def _write(hook: str, payload: dict) -> None:
    rec = {
        "hook": hook, "ts": time.time(), "pid": os.getpid(),
        "proc": " ".join(sys.argv[:3])[:120],
        "kanban_task": os.environ.get("HERMES_KANBAN_TASK"),
        "single_query": os.environ.get("HERMES_SINGLE_QUERY_SESSION"),
        "payload": payload,
    }
    line = json.dumps(rec, default=lambda o: repr(o)[:300])
    with _lock, open(_LOG, "a", encoding="utf-8") as f:
        f.write(line[:8000] + "\n")


def _make(hook: str):
    def cb(*args, **kwargs):
        try:
            _write(hook, {"args": list(args)[:3], **kwargs})
            if hook == "pre_approval_request":
                _maybe_resolve(kwargs)
            if hook == "pre_tool_call":
                _maybe_grant(kwargs)
        except Exception as exc:  # never break the agent
            try:
                _write(hook + ".error", {"error": repr(exc)})
            except Exception:
                pass
        return None
    return cb


def _maybe_resolve(kw: dict) -> None:
    if not _DECISION.exists():
        return
    choice = _DECISION.read_text().strip() or "deny"
    session_key, request_id = kw.get("session_key"), kw.get("request_id")

    def later():
        time.sleep(1.5)
        try:
            from tools.approval import resolve_gateway_approval
            n = resolve_gateway_approval(session_key, choice, request_id=request_id)
            _write("probe.resolve", {"session_key": session_key, "request_id": request_id, "choice": choice, "resolved": n})
        except Exception as exc:
            _write("probe.resolve.error", {"error": repr(exc)})

    threading.Thread(target=later, daemon=True).start()


def _maybe_grant(kw: dict) -> None:
    # grant file: "<pattern_key>|<kanban task id>" -> in-memory-only allow for this worker process
    if not _GRANT.exists():
        return
    pattern, _, task = _GRANT.read_text().strip().partition("|")
    if task and os.environ.get("HERMES_KANBAN_TASK") != task:
        return
    try:
        from tools.approval import approve_permanent
        approve_permanent(pattern)
        _write("probe.grant", {"pattern_key": pattern, "task": task, "mode": "in-memory approve_permanent"})
    except Exception as exc:
        _write("probe.grant.error", {"error": repr(exc)})


_HOOKS = [
    "pre_tool_call", "post_tool_call", "pre_approval_request", "post_approval_response",
    "on_session_start", "on_session_end", "on_interim_message", "subagent_start", "subagent_stop",
    "on_human_input_request", "on_human_input_resolved",
    "on_kanban_worker_spawned", "on_kanban_worker_exited", "on_kanban_task_updated",
]


def register(ctx) -> None:
    for h in _HOOKS:
        ctx.register_hook(h, _make(h))
