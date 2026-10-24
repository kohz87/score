import io
import json
from urllib.error import HTTPError

import pytest

import score_bridge
import score_bridge.exchanges
import score_bridge.knowledge
from score_bridge import exchanges
from score_bridge.client import ScoreClient
from helpers import FakeTransport

CAP = "xtc_" + "a" * 43


class Bridge(FakeTransport):
    """Fake bridge: hello from FakeTransport, exchange calls answered by `reply`."""

    def __init__(self):
        super().__init__()
        self.reply = lambda body: {}

    def __call__(self, url, token, body, timeout):
        if not url.endswith("/bridge/v1/exchanges/action"):
            return super().__call__(url, token, body, timeout)
        self.calls.append((url, token, body, timeout))
        if self.down:
            raise ConnectionRefusedError("Score unavailable")
        if self.unauthorized:
            self.unauthorized = False
            raise HTTPError(url, 401, "expired", {}, io.BytesIO(b"{}"))
        out = self.reply(body)
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
    return exchanges.make_handlers(exchanges.ExchangeClient(bridge.client))


def run(handler, **args):
    return json.loads(handler(args))


def receipt(body, status="staged", code=None):
    out = {"status": status, "commandId": body["commandId"], "action": body["action"]["action"], "message": "ok"}
    if code is not None:
        out["code"] = code
    return out


def exchange_calls(bridge):
    return [c for c in bridge.calls if c[0].endswith("/bridge/v1/exchanges/action")]


def test_registers_six_tools_through_public_register_tool():
    seen = []

    class Ctx:
        def register_tool(self, **kwargs):
            seen.append(kwargs)

    exchanges.register_tools(Ctx())
    assert [s["name"] for s in seen] == [
        "score_handoff", "score_ask", "score_review", "score_approve", "score_send_back", "score_reply",
    ]
    for s in seen:
        assert s["toolset"] == "score_exchanges" and callable(s["handler"])
        assert s["schema"]["parameters"]["type"] == "object"
        assert s["schema"]["parameters"]["additionalProperties"] is False
        for phrase in ("copy it exactly", "when the turn ends", "only if the turn completes",
                       "at most one routing action", "replaces", "reviewer of an open review", "score_reply"):
            assert phrase in s["schema"]["description"]
    assert seen[5]["schema"]["parameters"]["required"] == ["capability", "text"]
    assert "replaces" not in seen[5]["schema"]["parameters"]["properties"]


@pytest.mark.parametrize("name,args,action", [
    ("score_handoff", {"capability": CAP, "to": "builder", "note": "Build it"},
     {"action": "handoff", "to": "builder", "note": "Build it"}),
    ("score_ask", {"capability": CAP, "to": "builder", "question": "Can you build it?"},
     {"action": "ask", "to": "builder", "question": "Can you build it?"}),
    ("score_review", {"capability": CAP, "to": "reviewer", "note": "Please review"},
     {"action": "review", "to": "reviewer", "note": "Please review"}),
    ("score_approve", {"capability": CAP, "note": "Looks good"},
     {"action": "approve", "note": "Looks good"}),
    ("score_send_back", {"capability": CAP, "note": "Needs tests"},
     {"action": "send_back", "note": "Needs tests"}),
    ("score_reply", {"capability": CAP, "text": "The answer is 42"},
     {"action": "reply", "text": "The answer is 42"}),
])
def test_each_tool_sends_the_exact_action_body(bridge, name, args, action):
    bridge.reply = receipt
    out = run(handlers(bridge)[name], **args, command_id="cmd-1")
    assert out["success"] is True
    calls = exchange_calls(bridge)
    assert len(calls) == 1
    assert calls[0][0].endswith("/bridge/v1/exchanges/action")
    assert calls[0][1] == "producer"
    assert calls[0][2] == {"capability": CAP, "commandId": "cmd-1", "action": action}


def test_replaces_is_sent_only_when_given(bridge):
    bridge.reply = receipt
    h = handlers(bridge)
    run(h["score_handoff"], capability=CAP, to="builder", note="Build", replaces="cmd-0")
    run(h["score_handoff"], capability=CAP, to="builder", note="Build")
    first, second = [c[2]["action"] for c in exchange_calls(bridge)]
    assert first == {"action": "handoff", "to": "builder", "note": "Build", "replaces": "cmd-0"}
    assert second == {"action": "handoff", "to": "builder", "note": "Build"}


def test_derived_command_id_is_stable_and_changes_with_each_field(bridge):
    bridge.reply = receipt
    h = handlers(bridge)
    run(h["score_handoff"], capability=CAP, to="builder", note="Build")
    run(h["score_handoff"], capability=CAP, to="builder", note="Build")
    run(h["score_handoff"], capability=CAP, to="builder", note="Build differently")
    run(h["score_handoff"], capability=CAP, to="reviewer", note="Build")
    run(h["score_handoff"], capability="xtc_" + "b" * 43, to="builder", note="Build")
    run(h["score_ask"], capability=CAP, to="builder", question="Build")
    ids = [c[2]["commandId"] for c in exchange_calls(bridge)]
    assert ids[0] == ids[1]
    assert len(set(ids[2:])) == len(ids[2:])
    assert ids[0] not in ids[2:]
    assert ids[0].startswith("x") and len(ids[0]) == 41
    assert ids[0] == exchanges.derived_command_id(
        CAP, {"action": "handoff", "to": "builder", "note": "Build"}
    )


def test_explicit_command_id_is_sent_as_given(bridge):
    bridge.reply = receipt
    run(handlers(bridge)["score_reply"], capability=CAP, text="Yes", command_id="agent:reply.1")
    assert exchange_calls(bridge)[0][2]["commandId"] == "agent:reply.1"


@pytest.mark.parametrize("name,args,message", [
    ("score_handoff", {"capability": CAP, "to": "builder"}, "note is required"),
    ("score_handoff", {"capability": CAP, "to": "builder", "note": "x", "agent_id": "other"},
     "unknown argument: agent_id"),
    ("score_handoff", {"capability": "orc_" + "a" * 43, "to": "builder", "note": "x"},
     "capability is not valid"),
    ("score_handoff", {"capability": CAP, "to": "builder", "note": "x\0y"},
     "note must not contain NUL"),
    ("score_handoff", {"capability": CAP, "to": "builder", "note": "é" * 2001},
     "note is too long"),
    ("score_ask", {"capability": CAP, "to": "builder", "question": "é" * 2001},
     "question is too long"),
    ("score_reply", {"capability": CAP, "text": "é" * 4001}, "text is too long"),
    ("score_handoff", {"capability": CAP, "to": "x" * 65, "note": "x"}, "to is too long"),
    ("score_handoff", {"capability": CAP, "to": "builder", "note": "x", "command_id": "bad id"},
     "command_id is not valid"),
    ("score_handoff", {"capability": CAP, "to": "builder", "note": "x", "command_id": "x" * 65},
     "command_id is too long"),
    ("score_handoff", {"capability": CAP, "to": "builder", "note": "x", "replaces": "bad/id"},
     "replaces is not valid"),
])
def test_validation_refusals_make_no_http_call(bridge, name, args, message):
    out = run(handlers(bridge)[name], **args)
    assert out["success"] is False and out["error"] == message
    assert bridge.calls == []


def test_staged_and_refused_receipts(bridge):
    h = handlers(bridge)
    bridge.reply = lambda body: receipt(body)
    staged = run(h["score_approve"], capability=CAP, note="ok")
    assert staged["success"] is True and staged["status"] == "staged"
    bridge.reply = lambda body: receipt(body, status="refused", code="not_member")
    refused = run(h["score_approve"], capability=CAP, note="ok")
    assert refused["success"] is False and refused["status"] == "refused"
    assert refused["code"] == "not_member" and refused["message"] == "ok"


def test_expired_token_renews_and_retries_once(bridge):
    h = handlers(bridge)
    bridge.reply = receipt
    assert run(h["score_handoff"], capability=CAP, to="builder", note="Build")["success"] is True
    bridge.unauthorized = True
    assert run(h["score_handoff"], capability=CAP, to="builder", note="Build")["success"] is True
    assert sum(1 for c in bridge.calls if c[0].endswith("/hello")) == 2
    assert len(exchange_calls(bridge)) == 3  # the rejected request, then the retried one


def test_score_down_returns_an_error_without_raising(bridge):
    bridge.down = True
    out = run(handlers(bridge)["score_ask"], capability=CAP, to="builder", question="Why?")
    assert out == {"success": False, "error": "Score is not reachable right now; the action was not sent."}


def test_http_error_is_reported(bridge):
    bridge.reply = lambda body: (409, {"error": {"code": "action_limit", "message": "One action already staged"}})
    out = run(handlers(bridge)["score_approve"], capability=CAP, note="ok")
    assert out["success"] is False and out["status"] == 409 and out["code"] == "action_limit"
    assert out["error"] == "One action already staged"


def test_missing_bootstrap_token_is_reported(tmp_path):
    transport = Bridge()
    client = exchanges.ExchangeClient(lambda: ScoreClient("http://x", tmp_path / "none", transport, profile="b"))
    out = json.loads(exchanges.make_handlers(client)["score_reply"]({"capability": CAP, "text": "ok"}))
    assert out["success"] is False and "not set up" in out["error"]


def test_register_keeps_exchange_tools_when_knowledge_registration_fails(monkeypatch):
    names = []

    class Ctx:
        def register_tool(self, **kwargs):
            names.append(kwargs["name"])

        def register_hook(self, *a):
            pass

    monkeypatch.setattr(score_bridge, "_sender", None)
    monkeypatch.setattr(score_bridge.knowledge, "register_tools", lambda ctx: (_ for _ in ()).throw(RuntimeError()))
    monkeypatch.setattr("score_bridge.client.ScoreClient", lambda *a, **k: (_ for _ in ()).throw(RuntimeError()))
    score_bridge.register(Ctx())
    assert names == ["score_handoff", "score_ask", "score_review", "score_approve", "score_send_back", "score_reply"]


def test_register_keeps_knowledge_tools_when_exchange_registration_fails(monkeypatch):
    names = []

    class Ctx:
        def register_tool(self, **kwargs):
            names.append(kwargs["name"])

        def register_hook(self, *a):
            pass

    monkeypatch.setattr(score_bridge, "_sender", None)
    monkeypatch.setattr(score_bridge.exchanges, "register_tools", lambda ctx: (_ for _ in ()).throw(RuntimeError()))
    monkeypatch.setattr("score_bridge.client.ScoreClient", lambda *a, **k: (_ for _ in ()).throw(RuntimeError()))
    score_bridge.register(Ctx())
    assert names == ["knowledge_search", "knowledge_read", "knowledge_list", "knowledge_write", "knowledge_append"]
