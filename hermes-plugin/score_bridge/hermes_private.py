"""The sole boundary for imports and calls into private Hermes APIs."""
from __future__ import annotations

import importlib
import os
import sys
import time
from functools import lru_cache

from .redact import local_redact

_APIS = (
    "agent.redact.redact_sensitive_text",
    "tools.approval.list_gateway_approvals",
    "tools.approval.resolve_gateway_approval",
    "tools.approval_detection.detect_dangerous_command",
    "hermes_cli.plugin_isolation.isolation_mode",
)
# Reported with the others, but looked up without importing (see ``gateway_session_store``).
_GATEWAY_RUNNER = "gateway.run._gateway_runner_ref"


@lru_cache(maxsize=None)
def _lookup(path: str):
    module, _, name = path.rpartition(".")
    try:
        value = getattr(importlib.import_module(module), name)
        return value if callable(value) else None
    except Exception:
        return None


def available() -> dict[str, bool]:
    return {**{path: _lookup(path) is not None for path in _APIS},
            _GATEWAY_RUNNER: gateway_session_store() is not None,
            "tools.approval._lock": callable(getattr(_lookup_attr("tools.approval._lock"), "acquire", None)),
            "tools.approval._gateway_queues": isinstance(_lookup_attr("tools.approval._gateway_queues"), dict)}


@lru_cache(maxsize=None)
def _lookup_attr(path: str):
    module, _, name = path.rpartition(".")
    try:
        return getattr(importlib.import_module(module), name)
    except Exception:
        return None


def snapshot_gateway_approvals(session_key: str, limit: int = 64, timeout: float = 0.005) -> list[dict] | None:
    """A bounded copy of one session's pending gateway approvals, or None when unavailable or contended.

    Mirrors ``tools.approval.list_gateway_approvals`` (Hermes e97923c3) but never waits on Hermes's approval lock
    for more than ``timeout`` and refuses to copy more than ``limit`` entries: this runs on a Hermes hook thread.
    """
    lock = _lookup_attr("tools.approval._lock")
    queues = _lookup_attr("tools.approval._gateway_queues")
    if lock is None or not isinstance(queues, dict) or not hasattr(lock, "acquire"):
        return None
    if not lock.acquire(timeout=timeout):
        return None
    try:
        queue = queues.get(session_key) or []
        if len(queue) > limit:
            return None
        return [dict(entry.data) for entry in queue]
    finally:
        lock.release()


# Adapted from NousResearch/hermes-agent tools/approval.py (e97923c3), Copyright (c) 2025 Nous Research.
def resolve_exact_bounded(session_key: str, choice: str, request_id: str, deadline: float,
                          cancelled=None) -> int | None:
    """Mirror resolve_gateway_approval's request-id branch under a bounded, atomic lock."""
    if type(request_id) is not str or not request_id:
        return 0
    lock = _lookup_attr("tools.approval._lock")
    queues = _lookup_attr("tools.approval._gateway_queues")
    if lock is None or not isinstance(queues, dict):
        return None
    # Short acquisition slices so shutdown (``cancelled``) is observed while waiting on Hermes's lock.
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or (cancelled is not None and cancelled.is_set()):
            return None
        if lock.acquire(timeout=min(remaining, 0.1)):
            break
    try:
        if time.monotonic() >= deadline or (cancelled is not None and cancelled.is_set()):
            return None
        queue = queues.get(session_key)
        if not queue:
            return 0
        targets = [entry for entry in queue if entry.data.get("request_id") == request_id]
        if len(targets) != 1:
            return 0
        queue[:] = [entry for entry in queue if entry not in targets]
        if not queue:
            queues.pop(session_key, None)
        entry = targets[0]
        entry.result = choice
        entry.event.set()
        return 1
    finally:
        lock.release()


def redact(text: str) -> str:
    fn = _lookup("agent.redact.redact_sensitive_text")
    if fn is not None:
        try:
            result = fn(text, force=True)
            if isinstance(result, str):
                return local_redact(result)
        except Exception:
            pass
    return local_redact(text)


def isolation_mode() -> str:
    # Hermes's helper returns in_process *inside* the external plugin host.
    if os.environ.get("HERMES_PLUGIN_HOST_PROCESS") == "1":
        return "host"
    fn = _lookup("hermes_cli.plugin_isolation.isolation_mode")
    try:
        mode = fn() if fn else "unknown"
        return mode if mode in ("host", "in_process") else "unknown"
    except Exception:
        return "unknown"


@lru_cache(maxsize=1)
def version_info() -> dict[str, str]:
    try:
        fn = _lookup("hermes_cli.version_info.get_version_info")
        info = fn() if fn else None
        return {"version": str(info.display_version), "codeSha": str(info.commit or "unknown")}
    except Exception:
        return {"version": "unknown", "codeSha": "unknown"}


def current_profile() -> str:
    fn = _lookup("hermes_cli.profiles.current_profile_name")
    try:
        profile = fn() if fn else None
        if type(profile) is str and profile:
            return profile
    except Exception:
        pass
    return os.environ.get("HERMES_PROFILE") or "default"


def detect_dangerous(command: str) -> str | None:
    """Recompute the canonical pattern without changing approval policy."""
    if type(command) is not str or len(command) > 16_384:
        return None
    fn = _lookup("tools.approval_detection.detect_dangerous_command")
    try:
        result = fn(command) if fn else None
        if (type(result) is tuple and len(result) == 3 and result[0] is True
                and type(result[1]) is str and 0 < len(result[1]) <= 256):
            return result[1]
    except Exception:
        pass
    return None


def gateway_session_store():
    """The running gateway's session store, or None outside a gateway (CLI, Kanban workers) or when it lacks a rewind.

    Looks only at an already imported ``gateway.run`` so a non-gateway process never imports the gateway.
    """
    module = sys.modules.get("gateway.run")
    ref = getattr(module, "_gateway_runner_ref", None)
    try:
        runner = ref() if callable(ref) else None
        store = getattr(runner, "session_store", None)
        return store if callable(getattr(store, "rewind_session", None)) else None
    except Exception:
        return None


def _is_user_turn(message) -> bool:
    """A row Hermes counts as a user turn when it rewinds (``hermes_state_rewind._user_indices``): plain user rows,
    typed ``/steer`` rows and compaction carriers that still wrap a human message; other display kinds are synthetic."""
    from agent.context_compressor import user_originated_turn_view
    return isinstance(message, dict) and user_originated_turn_view(message) is not None


def _user_turns(db, session_id: str) -> list[float | None]:
    """Timestamps of the user turns of the session as Hermes replays them: the alternation-repaired projection, where
    consecutive user rows with no assistant row between them are one turn (what ``rewind_session`` counts)."""
    messages = db.get_messages_as_conversation(session_id, repair_alternation=True, include_row_ids=True)
    turns = []
    for message in messages:
        if not _is_user_turn(message):
            continue
        stamp = message.get("timestamp")
        turns.append(float(stamp) if type(stamp) in (int, float) else None)
    return turns


def rewind_session(session_id: str, turns: int, since: float | None = None) -> dict | None:
    """Back a session up with Hermes's own rewind (what ``/undo N`` uses).

    ``gateway.session_transcript.SessionTranscriptMixin.rewind_session`` soft-deletes the rows (``active = 0``); the
    next turn rebuilds its history from the active rows. With ``since`` (epoch seconds of the message being rewound)
    the target is absolute: the number of turns is computed here on the repaired projection Hermes itself counts, as
    every user turn from the first one at or after ``since``, so a turn without a reply can't make the rewind reach back
    past the message. ``turns`` (Score's own count) is then only a sanity bound. Returns ``{"turns_undone",
    "rewound_count"}``, or None when Hermes had nothing to rewind or refused. Raises when no gateway is running here,
    when no turn starts at or after ``since``, or when turns from ``since`` are still active afterwards.
    """
    store = gateway_session_store()
    if store is None:
        raise RuntimeError("no gateway session store")
    if type(session_id) is not str or not session_id or type(turns) is not int or turns < 1:
        raise ValueError("invalid rewind")
    db = None
    if since is not None:
        if type(since) not in (int, float) or since <= 0:
            raise ValueError("invalid rewind")
        db = store._db_for_session_id(session_id)
        stamps = _user_turns(db, session_id)
        first = next((index for index, stamp in enumerate(stamps) if stamp is not None and stamp >= since), None)
        if first is None:
            raise ValueError("no turn since the message")
        turns = len(stamps) - first
        # A turn that began before the message without a reply merges with it in the projection: rewinding it would
        # take that older turn along, and rewinding less would leave the message. Refuse rather than guess.
        raw = db.get_messages_as_conversation(session_id, include_row_ids=True)
        for index, message in enumerate(raw):
            stamp = message.get("timestamp") if isinstance(message, dict) else None
            if _is_user_turn(message) and type(stamp) in (int, float) and stamp >= since:
                before = raw[index - 1] if index else None
                if _is_user_turn(before):
                    raise ValueError("the message shares a turn with an earlier unanswered one")
                break
    result = store.rewind_session(session_id, turns)
    if not isinstance(result, dict):
        return None
    undone, count = result.get("turns_undone"), result.get("rewound_count")
    if type(undone) is not int or type(count) is not int:
        return None
    if db is not None and any(
            _is_user_turn(m) and type(m.get("timestamp")) in (int, float) and m["timestamp"] >= since
            for m in db.get_messages_as_conversation(session_id)):
        raise RuntimeError("turns since the message are still active")
    return {"turns_undone": undone, "rewound_count": count}
