"""Regression probes for redaction, snapshots and payload budgets."""

import contextvars
import hashlib
import json
import threading
from pathlib import Path

import pytest

from score_bridge import hermes_private
from score_bridge.redact import PAYLOAD_CAP, local_redact, scrub, snapshot
from helpers import make_hook


def test_02_oversized_leaf_never_reaches_redactor(setup, monkeypatch):
    sender, transport = setup
    seen = []
    monkeypatch.setattr(hermes_private, "redact", lambda text: seen.append(len(text)) or local_redact(text))
    huge = "password=raw " + "x" * 20_000_000
    make_hook("post_tool_call", sender)(result=huge)
    sender.process_once()
    assert max(seen) <= 16384
    assert transport.acked[0]["payload"]["result"] == f"[omitted: {len(huge)} chars]"
    assert "raw" not in json.dumps(transport.acked)


def test_02_exact_types_node_depth_and_event_size_budgets(setup):
    sender, _ = setup
    called = []
    class Foreign(dict):
        def items(self):
            called.append(True)
            raise RuntimeError()
        def __repr__(self):
            called.append(True)
            raise RuntimeError()
    class Meta(type):
        def __eq__(self, other):
            raise AssertionError("foreign type comparison")
        @property
        def __name__(self):
            raise AssertionError("foreign descriptor")
    class Hostile(metaclass=Meta):
        pass
    assert snapshot({"foreign": Foreign(), "obj": Hostile()}) == {"foreign": "<Foreign>", "obj": "<Hostile>"}
    assert not called
    def nodes(value):
        if type(value) is dict:
            return 1 + sum(1 + nodes(child) for child in value.values())
        if type(value) is list:
            return 1 + sum(nodes(child) for child in value)
        return 1
    assert nodes(snapshot(list(range(5000)))) <= 2000
    assert nodes(snapshot({str(i): [1] for i in range(5000)})) <= 2000
    deep = None
    for _ in range(100):
        deep = [deep]
    assert "[omitted]" in json.dumps(snapshot(deep))
    sender.enqueue("post_tool_call", (), {"result": ["x" * 16384] * 100})
    built = sender._build(sender._take()[0])
    assert len(json.dumps(built["payload"], separators=(",", ":")).encode()) <= PAYLOAD_CAP
    assert "[omitted:" in json.dumps(built)


def test_04_profile_context_redaction_and_independent_tokens(setup, monkeypatch):
    sender, _ = setup
    profile = contextvars.ContextVar("profile", default="default")
    monkeypatch.setattr(hermes_private, "current_profile", profile.get)
    secrets = {"builder": "opaque-builder-vault", "reviewer": "opaque-reviewer-vault"}
    monkeypatch.setattr(hermes_private, "redact", lambda text: text.replace(secrets.get(profile.get(), "unused"), "[redacted]"))
    identities, received = {}, []
    def transport(url, token, body, timeout):
        if url.endswith("hello"):
            identities[body["profile"]] = body
            return {"producerToken": body["profile"], "expiresAt": "2030-01-01T00:00:00Z",
                    "enabled": {"watch": True, "gatewayApprovals": False, "kanbanGrants": False}}
        received.append((token, body["events"]))
        return {"ackedThrough": body["events"][-1]["counter"]}
    sender.client.transport = transport
    for name, secret in secrets.items():
        marker = profile.set(name)
        make_hook("post_tool_call", sender)(result=secret)
        profile.reset(marker)
    worker = threading.Thread(target=sender.process_once)
    worker.start()
    worker.join(2)
    assert not worker.is_alive()
    assert {token for token, _ in received} == set(secrets)
    for name, events in received:
        assert events[0]["payload"]["result"] == "[redacted]"
        assert events[0]["counter"] == 1
        assert identities[name]["incarnation"] == sender.process_incarnation + "-" + name
    assert len({client.incarnation for client, _ in sender._producers.values()}) == 3


@pytest.mark.parametrize("failure", ["missing", "throwing"])
def test_05_credential_fields_and_assignments_with_unavailable_hermes(failure, monkeypatch):
    # Load just the boundary implementation, replacing imports before any lookup.
    import importlib.util
    path = Path(__file__).parents[1] / "score_bridge/hermes_private.py"
    spec = importlib.util.spec_from_file_location("score_bridge._credential_probe", path)
    private = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(private)
    def fake_import(name):
        if failure == "missing":
            raise ImportError()
        from types import SimpleNamespace
        def broken(*args, **kwargs):
            raise RuntimeError()
        return SimpleNamespace(redact_sensitive_text=broken)
    monkeypatch.setattr(private.importlib, "import_module", fake_import)
    names = ["apiKey", "AWS_SECRET_ACCESS_KEY", "clientSecret", "AWS_ACCESS_KEY_ID", "X-API-Key",
             "password", "passwd", "secret", "token", "accessKey", "private key", "Authorization",
             "Cookie", "credential", "prefix_client-secret_suffix"]
    payload = {name: {"nested": ["opaque-credential"]} for name in names}
    assert set(scrub(payload, private.redact).values()) == {"[redacted]"}
    for name in names:
        for text in (name + "=opaque-credential", name + ": opaque-credential", '"' + name + '": "opaque-credential"'):
            assert "opaque-credential" not in private.redact(text), text


def test_06_snapshot_and_digest_precede_mutation(setup):
    sender, _ = setup
    args = {"command": "echo before", "nested": ["before"]}
    make_hook("pre_tool_call", sender)(args=args)
    args["command"] = "echo after"
    args["nested"].append("after")
    built = sender._build(sender._take()[0])
    assert built["payload"]["args"] == {"command": "echo before", "nested": ["before"]}
    assert built["payload"]["command_digest"] == hashlib.sha256(b"echo before").hexdigest()
