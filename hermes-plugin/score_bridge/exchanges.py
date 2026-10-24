"""Exchange action tools: route work, ask, review, approve, send back or reply through Score.

Registered through Hermes's public ``ctx.register_tool``. The agent is identified by the bridge producer token (the
profile Hermes runs as), never by a tool argument. Every handler returns a JSON string and never raises.
"""
from __future__ import annotations

import hashlib
import json
import re
from urllib.error import HTTPError

from .client import NotReady
from .knowledge import BridgeToolClient, _http_error, error

TOOLSET = "score_exchanges"
TIMEOUT = 20.0

_CAPABILITY = re.compile(r"^xtc_[A-Za-z0-9_-]{43}$")
_COMMAND_ID = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
_BYTE_LIMITS = {"note": 4000, "question": 4000, "text": 8000}

_COMMON = (
    "Use this for your current turn in a Score exchange. The capability is in this turn's instructions from Score; "
    "copy it exactly and never put it in a note. The action takes effect when the turn ends, and only if the turn "
    "completes. Use at most one routing action per turn (handoff, ask, review, approve or send_back); to replace a "
    "second one, pass replaces with the first action's command id. score_approve and score_send_back are only for the "
    "reviewer of an open review. score_reply marks the answer to a question you were asked; otherwise the whole final "
    "reply is the answer."
)

_CAPABILITY_PROP = {
    "type": "string",
    "minLength": 1,
    "maxLength": 47,
    "pattern": "^xtc_[A-Za-z0-9_-]{43}$",
    "description": "The per-turn capability from Score's instructions; copy it exactly.",
}
_TO_PROP = {"type": "string", "minLength": 1, "maxLength": 64, "description": "Agent id to send to."}
_COMMAND_PROP = {
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": "^[A-Za-z0-9._:-]+$",
    "description": "Stable command id. Omit it and Score derives one so an exact repeat is idempotent.",
}
_REPLACES_PROP = {
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": "^[A-Za-z0-9._:-]+$",
    "description": "The command id of the routing action this one replaces.",
}
_NOTE_PROP = {"type": "string", "minLength": 1, "description": "Note for the recipient (at most 4000 UTF-8 bytes)."}
_QUESTION_PROP = {"type": "string", "minLength": 1, "description": "Question for the recipient (at most 4000 UTF-8 bytes)."}
_TEXT_PROP = {"type": "string", "minLength": 1, "description": "The answer text (at most 8000 UTF-8 bytes)."}


def _routing_schema(description: str, action_prop: tuple[str, dict], required: list[str]) -> dict:
    return {
        "description": _COMMON + " " + description,
        "parameters": {
            "type": "object",
            "properties": {
                "capability": _CAPABILITY_PROP,
                "to": _TO_PROP,
                action_prop[0]: action_prop[1],
                "command_id": _COMMAND_PROP,
                "replaces": _REPLACES_PROP,
            },
            "required": ["capability", *required],
            "additionalProperties": False,
        },
    }


SCHEMAS = {
    "score_handoff": _routing_schema(
        "Hand work on to another agent.", ("note", _NOTE_PROP), ["to", "note"]
    ),
    "score_ask": _routing_schema(
        "Ask another agent a question.", ("question", _QUESTION_PROP), ["to", "question"]
    ),
    "score_review": _routing_schema(
        "Ask another agent to review the work.", ("note", _NOTE_PROP), ["to", "note"]
    ),
}
SCHEMAS["score_approve"] = {
    "description": _COMMON + " Approve the work you are reviewing.",
    "parameters": {
        "type": "object",
        "properties": {
            "capability": _CAPABILITY_PROP,
            "note": _NOTE_PROP,
            "command_id": _COMMAND_PROP,
            "replaces": _REPLACES_PROP,
        },
        "required": ["capability", "note"],
        "additionalProperties": False,
    },
}
SCHEMAS["score_send_back"] = {
    "description": _COMMON + " Send reviewed work back for changes.",
    "parameters": {
        "type": "object",
        "properties": {
            "capability": _CAPABILITY_PROP,
            "note": _NOTE_PROP,
            "command_id": _COMMAND_PROP,
            "replaces": _REPLACES_PROP,
        },
        "required": ["capability", "note"],
        "additionalProperties": False,
    },
}
SCHEMAS["score_reply"] = {
    "description": _COMMON + " Mark your answer to a question Score asked you.",
    "parameters": {
        "type": "object",
        "properties": {
            "capability": _CAPABILITY_PROP,
            "text": _TEXT_PROP,
            "command_id": _COMMAND_PROP,
        },
        "required": ["capability", "text"],
        "additionalProperties": False,
    },
}

_DECIDE = (
    " Only when Score asked you, as the lead, to decide on a paused exchange; once per exchange."
)
SCHEMAS["score_extend"] = {
    "description": _COMMON + _DECIDE + " Give the paused exchange more turns.",
    "parameters": {
        "type": "object",
        "properties": {
            "capability": _CAPABILITY_PROP,
            "turns": {"type": "integer", "minimum": 1, "maximum": 100,
                      "description": "How many more turns (at most the job's exchange budget)."},
            "note": _NOTE_PROP,
            "command_id": _COMMAND_PROP,
        },
        "required": ["capability", "turns", "note"],
        "additionalProperties": False,
    },
}
SCHEMAS["score_stop_exchange"] = {
    "description": _COMMON + _DECIDE + " Stop the paused exchange.",
    "parameters": {
        "type": "object",
        "properties": {
            "capability": _CAPABILITY_PROP,
            "note": _NOTE_PROP,
            "command_id": _COMMAND_PROP,
        },
        "required": ["capability", "note"],
        "additionalProperties": False,
    },
}
DESCRIPTIONS = {
    "score_handoff": "Hand work on to another agent in this Score exchange.",
    "score_ask": "Ask another agent a question in this Score exchange.",
    "score_review": "Ask another agent to review work in this Score exchange.",
    "score_approve": "Approve the work you are reviewing in this Score exchange.",
    "score_send_back": "Send reviewed work back for changes in this Score exchange.",
    "score_reply": "Mark your answer to a question you were asked in this Score exchange.",
    "score_extend": "As the lead, give a paused Score exchange more turns.",
    "score_stop_exchange": "As the lead, stop a paused Score exchange.",
}

_TYPES = {"string": str, "integer": int, "null": type(None)}


def _validate(schema: dict, args) -> str | None:
    """Minimal JSON-Schema check plus the contract's byte limits and patterns; the server validates again."""
    if not isinstance(args, dict):
        return "arguments must be an object"
    params = schema["parameters"]
    props = params["properties"]
    for name in params.get("required", []):
        if name not in args:
            return f"{name} is required"
    for name, value in args.items():
        spec = props.get(name)
        if spec is None:
            return f"unknown argument: {name}"
        kinds = spec["type"] if isinstance(spec["type"], list) else [spec["type"]]
        if not any(type(value) is _TYPES[k] for k in kinds):
            return f"{name} must be {' or '.join(kinds)}"
        if type(value) is int and not spec.get("minimum", value) <= value <= spec.get("maximum", value):
            return f"{name} must be between {spec['minimum']} and {spec['maximum']}"
        if type(value) is not str:
            continue
        if "\0" in value:
            return f"{name} must not contain NUL"
        if len(value) < spec.get("minLength", 0):
            return f"{name} must not be empty"
        if "maxLength" in spec and len(value) > spec["maxLength"]:
            return f"{name} is too long"
        limit = _BYTE_LIMITS.get(name)
        if limit is not None and len(value.encode("utf-8")) > limit:
            return f"{name} is too long"
        pattern = _CAPABILITY if name == "capability" else _COMMAND_ID if name in ("command_id", "replaces") else None
        if pattern is not None and pattern.fullmatch(value) is None:
            return f"{name} is not valid"
    return None


def _action(name: str, args: dict) -> dict:
    if name == "score_handoff":
        action = {"action": "handoff", "to": args["to"], "note": args["note"]}
    elif name == "score_ask":
        action = {"action": "ask", "to": args["to"], "question": args["question"]}
    elif name == "score_review":
        action = {"action": "review", "to": args["to"], "note": args["note"]}
    elif name == "score_approve":
        action = {"action": "approve", "note": args["note"]}
    elif name == "score_send_back":
        action = {"action": "send_back", "note": args["note"]}
    elif name == "score_extend":
        action = {"action": "extend", "turns": args["turns"], "note": args["note"]}
    elif name == "score_stop_exchange":
        action = {"action": "stop_exchange", "note": args["note"]}
    else:
        action = {"action": "reply", "text": args["text"]}
    if "replaces" in args:
        action["replaces"] = args["replaces"]
    return action


def derived_command_id(capability: str, action: dict) -> str:
    canonical = json.dumps(action, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256((capability + "\n" + canonical).encode("utf-8")).hexdigest()
    return "x" + digest[:40]


class ExchangeClient(BridgeToolClient):
    def call(self, body: dict) -> dict:
        return self.post("/bridge/v1/exchanges/action", body)


_client = ExchangeClient()


def _run(name: str, args, client=None) -> str:
    try:
        problem = _validate(SCHEMAS[name], args)
        if problem:
            return error(problem)
        action = _action(name, args)
        command_id = args.get("command_id") or derived_command_id(args["capability"], action)
        receipt = (client or _client).call(
            {"capability": args["capability"], "commandId": command_id, "action": action}
        )
        return json.dumps({"success": receipt.get("status") == "staged", **receipt},
                          ensure_ascii=False, allow_nan=False)
    except HTTPError as exc:
        return _http_error(exc)
    except NotReady:
        return error("Score is not set up on this machine yet, so exchange actions are unavailable.")
    except Exception:
        return error("Score is not reachable right now; the action was not sent.")


def make_handlers(client=None):
    def handler(name):
        def call(args, **_):
            return _run(name, args, client)

        return call

    return {name: handler(name) for name in SCHEMAS}


def register_tools(ctx, client=None) -> None:
    register = getattr(ctx, "register_tool", None)
    if not callable(register):
        return
    handlers = make_handlers(client)
    for name, schema in SCHEMAS.items():
        try:
            register(name=name, toolset=TOOLSET, schema=schema, handler=handlers[name],
                     description=DESCRIPTIONS[name])
        except Exception:
            pass
