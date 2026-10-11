"""The sole boundary for imports and calls into private Hermes APIs."""
from __future__ import annotations

import importlib
from pathlib import Path
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


def _profile_session_db(profile: str | None):
    """The profile's own SessionDB from Hermes's process-wide registry (one shared handle per path, the one the API
    server writes through). A multiplexed gateway's session store only knows the sessions in its routing index and
    falls back to the root store for any other id, so API-server sessions of a named profile (Score's rooms) are not
    reachable through it."""
    get_dir = _lookup("hermes_cli.profiles.get_profile_dir")
    acquire = _lookup("hermes_state_registry.acquire")
    if get_dir is None or acquire is None:
        raise RuntimeError("profile session store unavailable")
    return acquire(Path(get_dir(profile or current_profile())) / "state.db")


def _release(db) -> None:
    release = _lookup("hermes_state_registry.release_or_close")
    if release is not None:
        release(db)


class CommandExpired(Exception):
    """The command's ``expiresAt`` passed before Hermes was touched: Score has already given up on it."""


def _check_fresh(expires_at: float | None) -> None:
    """Called immediately before a mutation: a command Score abandoned must not act on work done since."""
    if expires_at is not None and time.time() >= expires_at:
        raise CommandExpired()


def rewind_session(session_id: str, turns: int, since: float | None = None, profile: str | None = None,
                   expires_at: float | None = None) -> dict | None:
    """Back a session up with Hermes's own rewind (what ``/undo N`` uses).

    ``hermes_state_rewind.rewind_user_turn`` soft-deletes the rows (``active = 0``); the next turn rebuilds its history
    from the active rows. A session the gateway's routing index knows (a messaging session, a continued outside
    session) goes through ``SessionTranscriptMixin.rewind_session``; any other session (API-server sessions such as
    Score's rooms) is rewound in ``profile``'s own store under the same transcript lock. With ``since`` (epoch seconds
    of the message being rewound) the target is absolute: the number of turns is computed here on the repaired
    projection Hermes itself counts, as every user turn from the first one at or after ``since``, so a turn without a
    reply can't make the rewind reach back past the message. ``turns`` (Score's own count) is then only a sanity bound.
    Returns ``{"turns_undone", "rewound_count"}``, or None when Hermes had nothing to rewind or refused. Raises when no
    gateway is running here, when no turn starts at or after ``since``, or when turns from ``since`` are still active
    afterwards.
    """
    store = gateway_session_store()
    if store is None:
        raise RuntimeError("no gateway session store")
    if type(session_id) is not str or not session_id or type(turns) is not int or turns < 1:
        raise ValueError("invalid rewind")
    if since is not None and (type(since) not in (int, float) or since <= 0):
        raise ValueError("invalid rewind")
    try:
        indexed = store._owner_key_for_session_id(session_id) is not None
    except Exception:
        indexed = False
    if indexed:
        # The store finds its own sessions' rows; the handle is only needed to count turns from ``since``.
        db = store._db_for_session_id(session_id) if since is not None else None
    else:
        db = _profile_session_db(profile)
    try:
        return _rewind_in(store, db, indexed, session_id, turns, since, expires_at)
    finally:
        if not indexed:
            _release(db)


def _anchored_target(db, session_id: str, since: float) -> tuple[int, object]:
    """The turn a rewind from ``since`` starts at, on the repaired projection Hermes counts: ``(turns from it to the
    end, its row id)``. Refuses a message that shares a turn with an earlier unanswered one: rewinding that turn would
    take the older one along, and rewinding less would leave the message."""
    stamps = _user_turns(db, session_id)
    first = next((index for index, stamp in enumerate(stamps) if stamp is not None and stamp >= since), None)
    if first is None:
        raise ValueError("no turn since the message")
    raw = db.get_messages_as_conversation(session_id, include_row_ids=True)
    row_id = None
    for index, message in enumerate(raw):
        stamp = message.get("timestamp") if isinstance(message, dict) else None
        if _is_user_turn(message) and type(stamp) in (int, float) and stamp >= since:
            before = raw[index - 1] if index else None
            if _is_user_turn(before):
                raise ValueError("the message shares a turn with an earlier unanswered one")
            row_id = message.get("_row_id")
            break
    return len(stamps) - first, row_id


def _rewind_in(store, db, indexed: bool, session_id: str, turns: int, since: float | None,
               expires_at: float | None = None) -> dict | None:
    if since is None:
        if indexed:
            _check_fresh(expires_at)
            result = store.rewind_session(session_id, turns)
            if not isinstance(result, dict):
                return None
            undone, count = result.get("turns_undone"), result.get("rewound_count")
        else:
            undone, count = _rewind_direct(store, db, False, session_id, turns, expires_at)
            if undone is None:
                return None
        if type(undone) is not int or type(count) is not int:
            return None
        return {"turns_undone": undone, "rewound_count": count}
    if db is None:
        raise RuntimeError("no session store for this session")
    # Count, rewind and verify under one hold of Hermes's transcript lock (re-entrant), so a concurrent /undo or
    # a new turn can't move the target between counting and mutating: the ordinal Hermes resolves is the one counted.
    with store._get_transcript_drain_lock():
        turns, row_id = _anchored_target(db, session_id, since)
        if _anchored_target(db, session_id, since) != (turns, row_id):
            raise RuntimeError("the transcript changed while rewinding")
        undone, count = _rewind_direct(store, db, indexed, session_id, turns, expires_at)
        if undone is None:
            return None
        if type(undone) is not int or type(count) is not int:
            return None
        if undone != turns or any(
                _is_user_turn(m) and type(m.get("timestamp")) in (int, float) and m["timestamp"] >= since
                for m in db.get_messages_as_conversation(session_id)):
            raise RuntimeError("turns since the message are still active")
    return {"turns_undone": undone, "rewound_count": count}


def _rewind_direct(store, db, indexed: bool, session_id: str, turns: int, expires_at: float | None = None):
    """``db.rewind_user_turn`` under the transcript lock, as ``SessionTranscriptMixin.rewind_session`` does it
    (without its own ordinal resolution): ``(turns_undone, rewound_count)``, or ``(None, None)`` when Hermes had no
    target."""
    unavailable = _lookup_attr("hermes_state_rewind.RewindTargetUnavailableError")
    with store._get_transcript_drain_lock():
        _check_fresh(expires_at)
        try:
            outcome = db.rewind_user_turn(session_id, -max(turns, 1))
        except Exception as error:
            if isinstance(unavailable, type) and isinstance(error, unavailable):
                return None, None
            raise
        if indexed:
            store._clear_dirty_transcript(session_id)
    return getattr(outcome, "turns_undone", None), getattr(outcome, "rewound_count", None)


class CompactLockHeld(Exception):
    """Hermes holds its compression lock for the session (an auto-compression or another /compress is running)."""


class SessionBusy(Exception):
    """The gateway has a turn running in this session."""


class CompactUnsupported(Exception):
    """The session's runtime cannot be compacted by a throwaway agent (codex_app_server, no provider credentials)."""


def _gateway_runner():
    module = sys.modules.get("gateway.run")
    ref = getattr(module, "_gateway_runner_ref", None)
    try:
        return ref() if callable(ref) else None
    except Exception:
        return None


def _session_running(runner, session_id: str) -> bool:
    """A turn of this session in the gateway's own running-agent table (API-server runs are Score's to check)."""
    running = getattr(runner, "_running_agents", None)
    if not isinstance(running, dict):
        return False
    return any(isinstance(key, str) and session_id in key for key in list(running))


def _profile_scope(runner, profile: str | None):
    """Multiplexed gateways resolve credentials through a per-profile secret scope, as the gateway's own
    ``_handle_compress_command`` installs it. A single-profile gateway needs none."""
    import contextlib
    config = getattr(runner, "config", None)
    scope = _lookup("gateway.run._profile_runtime_scope")
    get_dir = _lookup("hermes_cli.profiles.get_profile_dir")
    if not getattr(config, "multiplex_profiles", False) or scope is None or get_dir is None:
        return contextlib.nullcontext()
    return scope(get_dir(profile or current_profile()))


def _build_compression_agent(runner, db, session_id: str, model, runtime_kwargs: dict):
    """A throwaway agent that performs the rewrite, adapted from ``_build_manual_compression_agent`` in hermes-agent
    gateway/slash_commands_session.py (MIT, see THIRD_PARTY_NOTICES.md)."""
    run_agent = importlib.import_module("run_agent")
    gateway_run = importlib.import_module("gateway.run")
    session_row = None
    try:
        session_row = db.get_session(session_id)
    except Exception:
        pass  # the live turn rebuilds its prompt with its configured providers
    agent = run_agent.AIAgent(**runtime_kwargs, model=model, max_iterations=4, quiet_mode=True, skip_memory=True,
                              enabled_toolsets=["memory"], session_id=session_id, session_db=db)
    gateway_run._seed_hygiene_system_prompt(agent, session_row)
    agent.platform = gateway_run._GATEWAY_HYGIENE_PLATFORM
    agent._print_fn = lambda *a, **kw: None
    # close() must not end a session the compression just rotated to.
    agent._end_session_on_close = False
    return agent


def compact_session(session_id: str, keep_recent: int | None = None, profile: str | None = None,
                    expires_at: float | None = None) -> dict | None:
    """Compact one session with Hermes's own manual-compress core (what ``/compress`` uses): the older turns are
    summarised, ``keep_recent`` recent exchanges stay word for word (``/compress here N``); absent = full compression.

    Works in ``profile``'s own store (Score's room sessions are API-server sessions the gateway's routing index does
    not know) under the transcript lock that rewind takes, so an ``/undo`` can't move the history under it.
    ``compress_now`` runs ``_compress_context(force=True)`` on the throwaway agent and Hermes commits the result itself
    (in place or as a compression continuation). Returns ``{"before": {...}, "after": {...}}`` (message count and
    Hermes's request-token estimate), or None when the session is too short to compact. Raises ``CompactLockHeld``,
    ``SessionBusy``, ``CompactUnsupported``, ``CommandExpired`` or whatever Hermes raised.
    """
    store = gateway_session_store()
    runner = _gateway_runner()
    if store is None or runner is None:
        raise RuntimeError("no gateway session store")
    if type(session_id) is not str or not session_id:
        raise ValueError("invalid compact")
    if keep_recent is not None and (type(keep_recent) is not int or not 0 < keep_recent <= 20):
        raise ValueError("invalid compact")
    manual = importlib.import_module("agent.conversation_compression_manual")
    notify = importlib.import_module("agent.conversation_compression")
    if _session_running(runner, session_id):
        raise SessionBusy()
    db = _profile_session_db(profile)
    agent = None
    committed = False
    try:
        with store._get_transcript_drain_lock():
            _check_fresh(expires_at)
            history = db.get_messages_as_conversation(session_id, include_row_ids=True)
            if not history or len(history) < manual.MIN_MESSAGES:
                return None
            # The full transcript, tool results included, like auto-compress.
            messages = [m for m in history if m.get("role") in {"user", "assistant", "tool"}]
            request = manual.CompressRequest(partial=True, keep_last=keep_recent) if keep_recent else \
                manual.CompressRequest()
            with _profile_scope(runner, profile):
                model, runtime_kwargs = runner._resolve_session_agent_runtime()
                if str(runtime_kwargs.get("api_mode") or "").lower() == "codex_app_server" \
                        or not runtime_kwargs.get("api_key"):
                    raise CompactUnsupported()
                runtime_kwargs["gateway_session_key"] = session_id
                # Same reasoning setting as a live turn: without it the transport applies its default effort, a 400 on
                # non-reasoning models.
                try:
                    runtime_kwargs["reasoning_config"] = runner._resolve_session_reasoning_config(
                        source=None, model=model)
                except Exception:
                    pass
                agent = _build_compression_agent(runner, db, session_id, model, runtime_kwargs)
                _check_fresh(expires_at)
                result = manual.compress_now(agent, messages, request, system_message="", skip_without_window=True,
                                             task_id=session_id)
            if result.status == "nothing_to_do":
                return None
            if result.status == "lock_skipped":
                raise CompactLockHeld()
            if result.status != "compressed":
                raise RuntimeError("compression did not run")
            notify.finalize_context_engine_compression_notification(agent, committed=True)
            committed = True
            return {"before": {"messages": len(result.before_messages), "tokens": int(result.before_tokens)},
                    "after": {"messages": len(result.after_messages), "tokens": int(result.after_tokens)}}
    finally:
        if agent is not None:
            if not committed:
                try:
                    notify.finalize_context_engine_compression_notification(agent, committed=False)
                except Exception:
                    pass
            close = getattr(agent, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
        _release(db)


_PART_KINDS = {"system_prompt", "tool_definitions", "rules", "skills", "mcp", "subagent_definitions", "memory",
               "conversation"}


def context_breakdown(session_id: str, profile: str | None = None) -> dict | None:
    """What is using a session's context window, from Hermes's own accounting (what ``/context`` reports,
    ``agent.context_breakdown.compute_session_context_breakdown``). Read-only and no model call: a throwaway agent is
    built only to read its prompt, tool schemas and compressor; it is closed straight away. Returns
    ``{"window", "used", "model", "source", "autoCompactAt", "parts": [{"kind", "label", "tokens"}]}``, or None when
    the session has no rows. Raises when no gateway runs here or Hermes fails."""
    runner = _gateway_runner()
    if runner is None or gateway_session_store() is None:
        raise RuntimeError("no gateway session store")
    if type(session_id) is not str or not session_id:
        raise ValueError("invalid context request")
    module = importlib.import_module("agent.context_breakdown")
    db = _profile_session_db(profile)
    agent = None
    try:
        history = db.get_messages_as_conversation(session_id, include_row_ids=True)
        if not history:
            return None
        messages = [m for m in history if m.get("role") in {"user", "assistant", "tool"}]
        with _profile_scope(runner, profile):
            model, runtime_kwargs = runner._resolve_session_agent_runtime()
            if not runtime_kwargs.get("api_key"):
                raise CompactUnsupported()
            agent = _build_compression_agent(runner, db, session_id, model, runtime_kwargs)
            payload = module.compute_session_context_breakdown(agent, messages)
        compressor = getattr(agent, "context_compressor", None)
        threshold = getattr(compressor, "threshold_tokens", None)
        parts = [{"kind": str(cat.get("id")), "label": str(cat.get("label") or cat.get("id"))[:60],
                  "tokens": max(0, int(cat.get("tokens") or 0))}
                 for cat in payload.get("categories") or [] if str(cat.get("id")) in _PART_KINDS]
        return {"window": max(0, int(payload.get("context_max") or 0)),
                "used": max(0, int(payload.get("context_used") or 0)),
                "model": str(payload.get("model") or "")[:200],
                "source": str(payload.get("context_source") or "local_estimate"),
                "autoCompactAt": int(threshold) if isinstance(threshold, (int, float)) and threshold > 0 else None,
                "parts": parts}
    finally:
        close = getattr(agent, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass
        _release(db)
