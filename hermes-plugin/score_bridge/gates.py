"""Thread-local gate identities, captured before a hook leaves its calling thread."""
from __future__ import annotations

import threading
import uuid

_state = threading.local()


def reset():
    global _state
    _state = threading.local()


def capture(hook, payload, command_digest):
    if hook in ("pre_tool_call", "on_session_end"):
        _state.open = []
        _state.closed_guardian = None
        return payload
    if hook not in ("pre_approval_request", "post_approval_response"):
        return payload
    stack = getattr(_state, "open", [])
    _state.open = stack
    surface = payload.get("surface")
    surface = surface if type(surface) is str else "unknown"
    family = "smart" if surface == "smart" else "human"
    # Same thread + top of stack is the exactness guarantee. Hermes redacts the guardian's and the prompt's copies of a
    # command differently, so the command digest can't be part of this check.
    context = (payload.get("tool_call_id"), payload.get("turn_id"), payload.get("session_id"))
    result = dict(payload)
    transport_id = result.pop("request_id", None) if surface.startswith("transport:") else None
    if surface.startswith("transport:"):
        result["transportRequestId"] = transport_id
    if hook == "pre_approval_request":
        linked = supersedes = None
        closed = getattr(_state, "closed_guardian", None)
        if family == "human" and stack and stack[-1]["context"] == context:
            if stack[-1]["family"] == "smart":
                linked = stack.pop()["id"]
            elif stack[-1]["coalesced"]:
                supersedes = stack.pop()["id"]
        if family == "human" and linked is None and closed and closed["context"] == context:
            linked = closed["id"]
        _state.closed_guardian = None
        gate = {"id": uuid.uuid4().hex, "family": family, "context": context,
                "coalesced": result.get("coalesced") is True, "transport_id": transport_id,
                "pattern_keys": tuple(key[:256] for key in payload.get("pattern_keys", [])[:16]
                                      if type(key) is str) if type(payload.get("pattern_keys")) is list else ()}
        stack.append(gate)
        del stack[:-16]
        result.update(gateId=gate["id"], linkedGateId=linked)
        if supersedes:
            result["supersedesGateId"] = supersedes
    else:
        gate = None
        for index in range(len(stack) - 1, -1, -1):
            if stack[index]["family"] == family:
                gate = stack.pop(index)
                break
        result["gateId"] = gate["id"] if gate else None
        if gate and surface.startswith("transport:"):
            result["transportRequestId"] = gate["transport_id"]
        _state.closed_guardian = gate if gate and family == "smart" and result.get("choice") == "smart_deny" else None
    return result
