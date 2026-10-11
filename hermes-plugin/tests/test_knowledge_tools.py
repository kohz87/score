import io
import json
from urllib.error import HTTPError

import pytest

import score_bridge
from score_bridge import knowledge
from score_bridge.client import ScoreClient
from helpers import FakeTransport


class Bridge(FakeTransport):
    """Fake bridge: hello from FakeTransport, knowledge calls answered by `reply`."""

    def __init__(self):
        super().__init__()
        self.reply = lambda op, body: {}
        self.expired_once = False

    def __call__(self, url, token, body, timeout):
        if "/knowledge/" not in url:
            return super().__call__(url, token, body, timeout)
        self.calls.append((url, token, body, timeout))
        if self.down:
            raise ConnectionRefusedError("Score unavailable")
        if self.unauthorized:
            self.unauthorized = False
            raise HTTPError(url, 401, "expired", {}, io.BytesIO(b"{}"))
        out = self.reply(url.rsplit("/", 1)[1], body)
        if isinstance(out, tuple):
            status, payload = out
            raise HTTPError(url, status, "err", {}, io.BytesIO(json.dumps(payload).encode()))
        return out


@pytest.fixture
def bridge(tmp_path):
    token = tmp_path / "bridge.token"
    token.write_text("bootstrap")
    transport = Bridge()
    transport.client = lambda: ScoreClient("http://x", token, transport, profile="builder")
    return transport


def handlers(bridge):
    return knowledge.make_handlers(knowledge.KnowledgeClient(bridge.client))


def run(handler, **args):
    return json.loads(handler(args))


def test_registers_five_tools_with_public_register_tool():
    seen = []

    class Ctx:
        def register_tool(self, **kwargs):
            seen.append(kwargs)

    knowledge.register_tools(Ctx())
    assert [s["name"] for s in seen] == ["knowledge_search", "knowledge_read", "knowledge_list",
                                         "knowledge_write", "knowledge_append"]
    for s in seen:
        assert s["toolset"] == "score_knowledge" and callable(s["handler"])
        assert s["schema"]["parameters"]["type"] == "object"
        assert s["schema"]["parameters"]["additionalProperties"] is False
        assert "Knowledge" in s["schema"]["description"]
    assert "Search" in seen[3]["schema"]["description"] and "etag" in seen[3]["schema"]["description"]


def test_package_register_adds_tools_even_when_hooks_cannot_start(monkeypatch):
    tools = []

    class Ctx:
        def register_tool(self, **kwargs):
            tools.append(kwargs["name"])

        def register_hook(self, *a):
            pass

    monkeypatch.setattr(score_bridge, "_sender", None)
    monkeypatch.setattr("score_bridge.client.ScoreClient", lambda *a, **k: (_ for _ in ()).throw(RuntimeError()))
    score_bridge.register(Ctx())
    assert len(tools) == 5


def test_search_read_list_write_append_shapes_and_request_bodies(bridge):
    h = handlers(bridge)
    bridge.reply = lambda op, body: {"items": [{"path": "a.md", "title": "A", "snippet": "[[x]]"}]}
    assert run(h["knowledge_search"], query="x", limit=5) == {
        "success": True, "items": [{"path": "a.md", "title": "A", "snippet": "[[x]]"}]}
    bridge.reply = lambda op, body: {"path": "a.md", "title": "A", "body": "hi", "etag": "e1", "truncated": False}
    assert run(h["knowledge_read"], path="a.md")["etag"] == "e1"
    bridge.reply = lambda op, body: {"folders": [], "notes": [], "truncated": False}
    assert run(h["knowledge_list"])["success"] is True
    bridge.reply = lambda op, body: {"etag": "e2", "path": "a.md"}
    assert run(h["knowledge_write"], path="a.md", body="b", expected_etag=None)["etag"] == "e2"
    assert run(h["knowledge_append"], path="a.md", text="c")["path"] == "a.md"
    bodies = [(c[0].rsplit("/", 1)[1], c[2]) for c in bridge.calls if "/knowledge/" in c[0]]
    assert bodies == [("search", {"query": "x", "limit": 5}), ("read", {"path": "a.md"}), ("list", {}),
                      ("write", {"path": "a.md", "body": "b", "expectedEtag": None}),
                      ("append", {"path": "a.md", "text": "c"})]
    # The producer token authenticates; no agent id travels in the body.
    assert all(c[1] == "producer" for c in bridge.calls if "/knowledge/" in c[0])
    assert all("agent" not in json.dumps(b) for _, b in bodies)


@pytest.mark.parametrize("name,args,message", [
    ("knowledge_search", {}, "query is required"),
    ("knowledge_search", {"query": "x", "limit": 21}, "limit must be between 1 and 20"),
    ("knowledge_search", {"query": ""}, "query must not be empty"),
    ("knowledge_read", {"path": 5}, "path must be string"),
    ("knowledge_write", {"path": "a.md", "body": "x"}, "expected_etag is required"),
    ("knowledge_write", {"path": "a.md", "body": "x", "expected_etag": 3}, "expected_etag must be string or null"),
    ("knowledge_append", {"path": "a.md", "text": "x", "agent_id": "other"}, "unknown argument: agent_id"),
])
def test_schema_validation_never_reaches_the_bridge(bridge, name, args, message):
    out = run(handlers(bridge)[name], **args)
    assert out == {"success": False, "error": message}
    assert bridge.calls == []


def test_non_object_arguments_are_an_error(bridge):
    assert json.loads(handlers(bridge)["knowledge_read"]("nope"))["success"] is False


def test_conflict_returns_current_etag_so_the_model_rereads(bridge):
    bridge.reply = lambda op, body: (409, {"error": {"code": "conflict", "message": "The note changed",
                                                      "details": {"etag": "cur"}}})
    out = run(handlers(bridge)["knowledge_write"], path="a.md", body="x", expected_etag="old")
    assert out == {"success": False, "error": "The note changed", "status": 409, "code": "conflict",
                   "current_etag": "cur"}


def test_off_rate_limit_and_size_errors_carry_the_server_message(bridge):
    h = handlers(bridge)
    bridge.reply = lambda op, body: (403, {"error": {"code": "knowledge_off",
                                                      "message": "Knowledge is turned off for agents"}})
    assert run(h["knowledge_read"], path="a.md")["error"] == "Knowledge is turned off for agents"
    bridge.reply = lambda op, body: (429, {"error": {"code": "rate_limited", "message": "slow down",
                                                      "details": {"retryAfterSeconds": 42}}})
    out = run(h["knowledge_append"], path="a.md", text="x")
    assert out["retry_after_seconds"] == 42 and out["status"] == 429
    bridge.reply = lambda op, body: (413, {"error": {"code": "payload_too_large", "message": "too big"}})
    assert run(h["knowledge_write"], path="a.md", body="x", expected_etag=None)["status"] == 413


def test_transport_errors_become_a_plain_unavailable_message(bridge):
    bridge.down = True
    out = run(handlers(bridge)["knowledge_list"])
    assert out["success"] is False and "not reachable" in out["error"]


def test_missing_bootstrap_token_is_reported(tmp_path):
    transport = Bridge()
    client = knowledge.KnowledgeClient(lambda: ScoreClient("http://x", tmp_path / "none", transport, profile="b"))
    out = json.loads(knowledge.make_handlers(client)["knowledge_list"]({}))
    assert out["success"] is False and "not set up" in out["error"]


def test_expired_token_is_renewed_once(bridge):
    h = handlers(bridge)
    bridge.reply = lambda op, body: {"folders": [], "notes": [], "truncated": False}
    run(h["knowledge_list"])
    bridge.unauthorized = True
    assert run(h["knowledge_list"])["success"] is True
    assert sum(1 for c in bridge.calls if c[0].endswith("/hello")) == 2


def test_garbage_error_body_still_gives_a_message(bridge):
    def reply(op, body):
        raise HTTPError("u", 502, "bad gateway", {}, io.BytesIO(b"<html>"))
    bridge.reply = reply
    out = run(handlers(bridge)["knowledge_read"], path="a.md")
    assert out["error"] == "Score answered HTTP 502" and out["status"] == 502


def test_tool_descriptions_explain_image_placeholders():
    # PLAN 6.8: notes may hold embedded images; agents only ever see [image: alt, size] placeholders.
    assert "[image: alt, size]" in knowledge.SCHEMAS["knowledge_read"]["description"]
    assert "[image: alt, size]" in knowledge.SCHEMAS["knowledge_write"]["description"]
    assert "can't add images" in knowledge.SCHEMAS["knowledge_write"]["description"]


def test_read_passes_placeholders_through_and_a_refused_image_write_explains_itself(bridge):
    h = handlers(bridge)
    bridge.reply = lambda op, body: {"path": "a.md", "title": "A", "etag": "e", "truncated": False,
                                     "kind": "note", "notice": None,
                                     "body": "# A\n[image: whiteboard, 240 KB]\n"}
    out = run(h["knowledge_read"], path="a.md")
    assert out["body"] == "# A\n[image: whiteboard, 240 KB]\n"
    bridge.reply = lambda op, body: (400, {"error": {"code": "images_not_allowed",
                                                      "message": "Agents cannot add embedded images to a note."}})
    refused = run(h["knowledge_write"], path="a.md", body="![x](data:image/png;base64,AAAA)", expected_etag="e")
    assert refused["success"] is False and refused["code"] == "images_not_allowed"
    assert "embedded images" in refused["error"]
