"""The sole boundary for imports and calls into private Hermes APIs."""
from __future__ import annotations

import importlib
import os
from functools import lru_cache

from .redact import local_redact

_APIS = (
    "agent.redact.redact_sensitive_text",
    "tools.approval.list_gateway_approvals",
    "tools.approval.resolve_gateway_approval",
    "tools.approval_detection.detect_dangerous_command",
    "hermes_cli.plugin_isolation.isolation_mode",
)


@lru_cache(maxsize=None)
def _lookup(path: str):
    module, _, name = path.rpartition(".")
    try:
        value = getattr(importlib.import_module(module), name)
        return value if callable(value) else None
    except Exception:
        return None


def available() -> dict[str, bool]:
    return {path: _lookup(path) is not None for path in _APIS}


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


def approval_lock_free(timeout: float) -> bool:
    """True when Hermes's approval lock can be taken within ``timeout`` (it is then released at once)."""
    lock = _lookup_attr("tools.approval._lock")
    if lock is None or not hasattr(lock, "acquire") or not lock.acquire(timeout=max(0.0, timeout)):
        return False
    lock.release()
    return True


def resolve_exact(session_key: str, choice: str, request_id: str) -> int:
    if type(request_id) is not str or not request_id:
        return 0
    fn = _lookup("tools.approval.resolve_gateway_approval")
    if fn is None:
        raise RuntimeError("approval API unavailable")
    return fn(session_key, choice, request_id=request_id)


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
