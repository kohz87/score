import hashlib
import json
from pathlib import Path

import pytest

import score_bridge
from score_bridge import hermes_private
from score_bridge.redact import digest, local_redact, scrub
from score_bridge.sender import Sender
from score_bridge.client import ScoreClient
from score_bridge.spool import Spool
from helpers import FakeTransport, make_hook

SECRET_CASES = [
    ("sk-abcdefghijk123456", "sk-abcdefghijk123456"),
    ("Bearer abc.def.secret", "abc.def.secret"),
    ("ghp_abcdefghijk123456", "ghp_abcdefghijk123456"),
    ("github_pat_abcdefghijk123456", "github_pat_abcdefghijk123456"),
    ("AKIA1234567890ABCDEF", "AKIA1234567890ABCDEF"),
    ("ASIA1234567890ABCDEF", "ASIA1234567890ABCDEF"),
    ("-----BEGIN RSA PRIVATE KEY-----\nprivate-material\n-----END RSA PRIVATE KEY-----", "private-material"),
    ("password=hunter123", "hunter123"),
    ("token=opaque-secret", "opaque-secret"),
    ("api_key='opaque-secret'", "opaque-secret"),
    ('{"API_TOKEN": "opaque-secret"}', "opaque-secret"),
]


@pytest.mark.parametrize("text,secret", SECRET_CASES)
def test_fallback_patterns(text, secret):
    assert secret not in local_redact(text)


def test_before_truncation_and_result_limit():
    crossing = "x " * 2045 + "sk-" + "a" * 100
    seen = []
    def redact(text):
        seen.append(text)
        return local_redact(text)
    result = scrub({"command": crossing, "result": "r" * 20_000}, redact)
    assert crossing in seen
    assert result["command"] == ("x " * 2045 + "[redacted]")[:4096]
    assert result["result"] == "[omitted: 20000 chars]"
    assert len(scrub({"result": "r" * 16384}, redact)["result"]) == 16384
    assert digest("echo token=raw") == hashlib.sha256(b"echo token=raw").hexdigest()


def test_circular_bad_repr_nan_and_key_secrets():
    class Bad:
        def __repr__(self):
            raise RuntimeError("token=raw")
    circular = []
    circular.append(circular)
    result = scrub({"obj": Bad(), "cycle": circular, "value": float("nan"), "api_key": "opaque",
                    "sk-abcdefgh123456": "safe", "repr": b"password=super-secret"}, local_redact)
    text = json.dumps(result, allow_nan=False)
    assert "opaque" not in text and "super-secret" not in text and "sk-abcdefgh123456" not in text
    assert result["obj"] == "<Bad>" and result["cycle"] == ["[circular]"]


@pytest.mark.parametrize("redactor", [lambda text: (_ for _ in ()).throw(ValueError()), lambda text: None])
def test_failed_redaction_never_exposes_secrets(redactor):
    assert "hunter123" not in json.dumps(scrub({"command": "password=hunter123"}, redactor))


def test_every_recorded_hook_and_every_registered_hook_redacts(tmp_path, monkeypatch):
    transport = FakeTransport()
    token = tmp_path / "token"
    token.write_text("bootstrap")
    client = ScoreClient(token_path=token, transport=transport)
    sender = Sender(client, Spool(client.incarnation, tmp_path / "spool"))
    calls = []
    def forced(text):
        calls.append(text)
        return local_redact(text)
    monkeypatch.setattr(hermes_private, "redact", forced)
    records = json.loads((Path(__file__).parent / "fixtures/l5-worker-hooks.json").read_text())
    payloads = [(rec["hook"], rec["payload"]) for rec in records if rec["hook"] in score_bridge.HOOKS]
    variants = json.loads((Path(__file__).parent / "fixtures/secret-hook-variants.json").read_text())
    assert {rec["hook"] for rec in variants} == set(score_bridge.HOOKS)
    payloads += [(rec["hook"], rec["payload"]) for rec in variants]
    for hook, original in payloads:
        payload = dict(original)
        payload["args"] = {"original": payload.get("args"), "command": "echo token=raw-command",
                           "secret_variants": [text for text, _ in SECRET_CASES]}
        payload["result"] = {"original": payload.get("result"), "secret_variants": [text for text, _ in SECRET_CASES]}
        if payload.get("command"):
            payload["original_command"] = payload["command"]
        payload["command"] = "echo password=raw-command"
        assert make_hook(hook, sender)("Bearer positional-secret", **payload) is None
    sender.process_once()
    assert len(transport.acked) == len(payloads)
    text = json.dumps(transport.acked)
    for _, secret in SECRET_CASES:
        assert secret not in text
    assert "raw-command" not in text and "positional-secret" not in text
    for secret in ("fixture-command-secret", "fixture-argument-secret", "fixture-result-secret",
                   "fixture-password-secret", "sk-fixture123456789", "ghp_fixture123456789"):
        assert secret not in text
    for event in transport.acked:
        assert event["payload"]["command_digest"] == digest("echo password=raw-command")
    assert "echo password=raw-command" in calls


def test_nested_terminal_command_digest(tmp_path):
    client = ScoreClient(transport=FakeTransport())
    sender = Sender(client, Spool(client.incarnation, tmp_path))
    sender.enqueue("pre_tool_call", (), {"tool_name": "terminal", "args": {"command": "token=raw"}})
    event = sender._build(sender._take()[0])
    assert event["payload"]["command_digest"] == digest("token=raw")
    assert "raw" not in event["payload"]["args"]["command"]
