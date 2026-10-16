"""Knowledge tools: model-callable access to Score's Knowledge over the authenticated bridge.

Registered through Hermes's public ``ctx.register_tool``. The agent is identified by the bridge producer token (the
profile Hermes runs as), never by a tool argument. Every handler returns a JSON string and never raises.
"""
from __future__ import annotations

import json
import os
import threading
from urllib.error import HTTPError

from .client import NotReady, ProtocolError, ScoreClient

TOOLSET = "score_knowledge"
TIMEOUT = 20.0

_VAULT = (
    "Score's shared Knowledge: Markdown notes (with [[wikilinks]]) that you, your teammates and the user all read and "
    "write, plus documents the user uploaded (PDF, DOCX, CSV, JSON, HTML; read-only for you). Use it "
    "for durable facts, decisions, plans and how-tos worth keeping, and to look things up in the user's documents. "
)
_SEARCH_FIRST = "Search (knowledge_search) before writing so you extend an existing note instead of duplicating it. "

SCHEMAS = {
    "knowledge_search": {
        "description": _VAULT + "Full-text search over all notes and the text of uploaded documents; returns paths, titles, snippets (matches in [[ ]]) and for each hit kind (note or document) and type.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 500, "description": "Words to look for."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20, "description": "Maximum hits (default 20)."},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    "knowledge_read": {
        "description": _VAULT + "Read one note. Returns its body (embedded images appear as numbered placeholders like [image 2: alt, 69 B]) and an etag; pass the etag to knowledge_write to update it. Given a document path (e.g. reports/q3.pdf) it returns the extracted text with kind \"document\" and a notice if the text is missing or cut; documents can't be written.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "minLength": 1, "maxLength": 1024,
                                    "description": "Path inside Knowledge, e.g. projects/launch.md (or reports/q3.pdf for an uploaded document)"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    "knowledge_list": {
        "description": _VAULT + "List the folders, notes (path, title, modified time) and uploaded documents (path, type, size), optionally inside one folder.",
        "parameters": {
            "type": "object",
            "properties": {"folder": {"type": "string", "maxLength": 1024,
                                      "description": "Folder inside Knowledge; omit for all of Knowledge."}},
            "additionalProperties": False,
        },
    },
    "knowledge_write": {
        "description": (
            _VAULT + _SEARCH_FIRST + "Create or replace a note's Markdown body. To create, pass expected_etag null "
            "(fails if the note exists). To update, read the note first and pass its etag; on a conflict you get the "
            "current etag back: re-read, merge and retry. Max 256 KB. Images in a note appear as numbered placeholders such as [image 2: alt, 69 B] (the note's 2nd image): copy each one exactly as you read it, number included, to keep that image; delete one to remove its image; you can't add images. Writes are normally versioned and can be undone by the user; the reply's history field says what happened: committed or unchanged (in history), not_versioned (the vault's .gitignore excludes the folder: no earlier version to go back to), failed or git_unavailable (saved, but history wasn't updated)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "minLength": 1, "maxLength": 1024, "description": "Path inside Knowledge, ending in .md"},
                "body": {"type": "string", "description": "The full Markdown body."},
                "expected_etag": {"type": ["string", "null"], "description": "Etag from knowledge_read, or null to create."},
            },
            "required": ["path", "body", "expected_etag"],
            "additionalProperties": False,
        },
    },
    "knowledge_append": {
        "description": (
            _VAULT + _SEARCH_FIRST + "Add text to the end of a note (creates it if missing). No etag needed; use this "
            "for logs and running lists. Max 256 KB."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "minLength": 1, "maxLength": 1024, "description": "Path inside Knowledge, ending in .md"},
                "text": {"type": "string", "minLength": 1, "description": "Markdown to append."},
            },
            "required": ["path", "text"],
            "additionalProperties": False,
        },
    },
}

DESCRIPTIONS = {
    "knowledge_search": "Search Score's shared Knowledge (notes and uploaded documents).",
    "knowledge_read": "Read a note (embedded images show as numbered placeholders like [image 2: alt, 69 B]), or the extracted text of an uploaded document, from Score's shared Knowledge.",
    "knowledge_list": "List notes in Score's shared Knowledge.",
    "knowledge_write": "Create or update a note in Score's shared Knowledge.",
    "knowledge_append": "Append text to a note in Score's shared Knowledge.",
}

_TYPES = {"string": str, "integer": int, "null": type(None)}


def _validate(schema: dict, args) -> str | None:
    """Minimal JSON-Schema check for the subset used above; the server validates again."""
    if not isinstance(args, dict):
        return "arguments must be an object"
    props = schema["parameters"]["properties"]
    for name in schema["parameters"].get("required", []):
        if name not in args:
            return f"{name} is required"
    for name, value in args.items():
        spec = props.get(name)
        if spec is None:
            return f"unknown argument: {name}"
        kinds = spec["type"] if isinstance(spec["type"], list) else [spec["type"]]
        if not any(type(value) is _TYPES[k] for k in kinds):
            return f"{name} must be {' or '.join(kinds)}"
        if type(value) is str and "minLength" in spec and len(value) < spec["minLength"]:
            return f"{name} must not be empty"
        if type(value) is str and "maxLength" in spec and len(value) > spec["maxLength"]:
            return f"{name} is too long"
        if type(value) is int and not spec.get("minimum", value) <= value <= spec.get("maximum", value):
            return f"{name} must be between {spec['minimum']} and {spec['maximum']}"
    return None


def result(**fields) -> str:
    return json.dumps({"success": True, **fields}, ensure_ascii=False, allow_nan=False)


def error(message: str, **fields) -> str:
    return json.dumps({"success": False, "error": message, **fields}, ensure_ascii=False, allow_nan=False)


class KnowledgeClient:
    """One bridge identity per process for tool calls (separate from the hook sender; no approval polling)."""

    def __init__(self, factory=ScoreClient):
        self._factory = factory
        self._lock = threading.Lock()
        self._client = None
        self._pid = None

    def _get(self):
        with self._lock:
            if self._client is None or self._pid != os.getpid():
                self._client = self._factory()
                self._client._allow_decisions = False
                self._pid = os.getpid()
            return self._client

    def call(self, op: str, body: dict) -> dict:
        client = self._get()
        url = client.base_url + "/bridge/v1/knowledge/" + op
        with client._hello_lock:
            if client.producer_token is None or client.expires_at <= client.clock() + 60:
                client._hello()
            token = client.producer_token
        try:
            response = client.transport(url, token, body, TIMEOUT)
        except HTTPError as exc:
            if exc.code != 401:
                raise
            with client._hello_lock:
                if client.producer_token == token:
                    client._hello()
                token = client.producer_token
            response = client.transport(url, token, body, TIMEOUT)
        if not isinstance(response, dict):
            raise ProtocolError("invalid response")
        return response


_client = KnowledgeClient()


def _http_error(exc: HTTPError) -> str:
    detail = {}
    try:
        raw = exc.read(65536) if hasattr(exc, "read") and exc.fp is not None else b""
        parsed = json.loads(raw or b"{}")
        detail = parsed.get("error", {}) if isinstance(parsed, dict) else {}
    except Exception:
        detail = {}
    code = detail.get("code") if isinstance(detail, dict) else None
    message = detail.get("message") if isinstance(detail, dict) else None
    details = detail.get("details") if isinstance(detail, dict) else None
    fields = {"status": exc.code}
    if isinstance(code, str):
        fields["code"] = code
    if isinstance(details, dict):
        if isinstance(details.get("etag"), str):
            fields["current_etag"] = details["etag"]
        if type(details.get("retryAfterSeconds")) is int:
            fields["retry_after_seconds"] = details["retryAfterSeconds"]
    return error(message if isinstance(message, str) and message else f"Score answered HTTP {exc.code}", **fields)


def _run(name: str, args, build, client=None) -> str:
    try:
        problem = _validate(SCHEMAS[name], args)
        if problem:
            return error(problem)
        op, body = build(args)
        return result(**(client or _client).call(op, body))
    except HTTPError as exc:
        return _http_error(exc)
    except NotReady:
        return error("Score is not set up on this machine yet, so Knowledge is unavailable.")
    except Exception:
        return error("Score is not reachable right now; Knowledge is unavailable. Try again later.")


def make_handlers(client=None):
    def search(args, **_):
        return _run("knowledge_search", args, lambda a: ("search", {"query": a["query"], **({"limit": a["limit"]} if "limit" in a else {})}), client)

    def read(args, **_):
        return _run("knowledge_read", args, lambda a: ("read", {"path": a["path"]}), client)

    def list_(args, **_):
        return _run("knowledge_list", args, lambda a: ("list", {"folder": a["folder"]} if "folder" in a else {}), client)

    def write(args, **_):
        return _run("knowledge_write", args,
                    lambda a: ("write", {"path": a["path"], "body": a["body"], "expectedEtag": a["expected_etag"]}), client)

    def append(args, **_):
        return _run("knowledge_append", args, lambda a: ("append", {"path": a["path"], "text": a["text"]}), client)

    return {"knowledge_search": search, "knowledge_read": read, "knowledge_list": list_,
            "knowledge_write": write, "knowledge_append": append}


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
