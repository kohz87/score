"""Bounded process claims: ambiguity always leaves the prompt view-only.

Known limit (Hermes e97923c3 gives a hook no handle to its own queue entry): if a prompt is answered on another
surface in the milliseconds between its enqueue and its hook, while a byte-identical command in the same session is
being prepared in a terminal batch, the hook can claim that identical entry. The first prompt's own post hook then
closes its card at once, and any binding is to an identical command. Exact ownership needs Hermes to pass the
request id to `pre_approval_request` (upstream).
"""
from __future__ import annotations

import threading
from collections import OrderedDict

from . import hermes_private
from .redact import LEAF_CAP

_claims = OrderedDict()
_lock = threading.Lock()


def reset():
    global _claims, _lock
    _claims, _lock = OrderedDict(), threading.Lock()


def reported(profile, session_key, request_id):
    if type(request_id) is not str or not request_id:
        return False
    with _lock:
        claim = _claims.get(request_id)
        return claim is not None and claim[:2] == (profile, session_key)


def capture_exact(raw, profile, gate_id):
    try:
        surface = raw.get("surface")
        if (type(surface) is not str or surface == "smart" or surface.startswith("transport:")
                or raw.get("coalesced") is True):
            return None
        session, command, keys = (raw.get(key) for key in ("session_key", "command", "pattern_keys"))
        # Refuse oversized/foreign inputs rather than running their equality methods in a hook.
        if (type(session) is not str or not session or type(command) is not str or len(command) > LEAF_CAP
                or type(keys) is not list or len(keys) > 64
                or any(type(key) is not str or len(key) > 256 for key in keys)):
            return None
        entries = hermes_private.snapshot_gateway_approvals(session)
        if type(entries) is not list or len(entries) > 64:
            return None
        candidates = []
        for entry in entries:
            if type(entry) is not dict:
                return None
            pending_command, pending_keys = entry.get("command"), entry.get("pattern_keys")
            if (type(pending_command) is not str or type(pending_keys) is not list
                    or len(pending_keys) > 64
                    or any(type(key) is not str or len(key) > 256 for key in pending_keys)):
                return None
            if pending_command == command and pending_keys == keys:
                candidates.append(entry)
        if len(candidates) != 1:
            return None
        request_id = candidates[0].get("request_id")
        if (type(request_id) is not str or not request_id or len(request_id) > 256
                or any(not 33 <= ord(char) <= 126 for char in request_id)):
            return None
        if not _lock.acquire(timeout=0.002):
            return None
        try:
            # Never evict: an evicted live id could be claimed again by another gate. Claims end at the gate's post
            # hook (release); when full, report null (view-only).
            if request_id in _claims or len(_claims) >= 4096:
                return None
            _claims[request_id] = (profile, session, gate_id)
        finally:
            _lock.release()
        return request_id
    except Exception:
        return None


def release(request_id):
    if type(request_id) is not str or not request_id:
        return
    if _lock.acquire(timeout=0.002):
        try:
            _claims.pop(request_id, None)
        finally:
            _lock.release()
