import json
from pathlib import Path

import pytest

from score_bridge import hermes_private
from score_bridge.kanban import capture_denial
from score_bridge.redact import digest
from score_bridge.sender import Sender
from score_bridge.client import ScoreClient
from score_bridge.spool import Spool
from helpers import FakeTransport, make_hook


@pytest.fixture
def raw(monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_test")
    monkeypatch.setenv("HERMES_KANBAN_RUN_ID", "17")
    monkeypatch.setattr(hermes_private, "detect_dangerous", lambda command: "delete" if command.startswith("rm ") else None)
    return {"tool_name": "terminal", "args": {"command": "rm -rf /tmp/example"}, "status": "error",
            "result": json.dumps({"status": "blocked", "error": "BLOCKED: Command flagged as dangerous: delete"})}


def test_verified_denial(raw):
    assert capture_denial(raw) == {"patternKey": "delete", "commandDigest": digest(raw["args"]["command"]),
                                   "taskId": "t_test", "runId": 17}


@pytest.mark.parametrize("change", [
    {"result": json.dumps({"status": "blocked", "error": "Tirith: command blocked"})},
    {"tool_name": "execute_code"}, {"tool_name": "editor"},
    {"args": {"command": "pwd"}}, {"result": "not json"}, {"result": "x" * 16385},
    {"result": {"status": "blocked"}}, {"result": "[]"},
    {"result": json.dumps({"status": "ok", "error": "BLOCKED: Command flagged as dangerous"})},
    {"result": json.dumps({"status": "blocked", "error": "execute_code is denied in unattended mode"})},
    {"args": {"command": "rm " + "x" * 16384}},
    {"result": json.dumps({"status": "blocked", "error": "BLOCKED: Command flagged as dangerous", "padding": "é" * 9000}, ensure_ascii=False)},
])
def test_unverified_results_are_ignored(raw, change):
    assert capture_denial({**raw, **change}) is None


def test_no_task(raw, monkeypatch):
    monkeypatch.delenv("HERMES_KANBAN_TASK")
    assert capture_denial(raw) is None


@pytest.mark.parametrize("run", ["", "invalid", "9" * 100, "-1", "9007199254740992"])
def test_invalid_run_is_null(raw, monkeypatch, run):
    monkeypatch.setenv("HERMES_KANBAN_RUN_ID", run)
    assert capture_denial(raw)["runId"] is None


def test_detector_failure_is_fail_open(raw, monkeypatch):
    def broken(command):
        raise RuntimeError("failure")
    monkeypatch.setattr(hermes_private, "detect_dangerous", broken)
    assert capture_denial(raw) is None


def test_hook_captures_raw_digest_and_redacts_before_spool(raw, monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(hermes_private, "detect_dangerous", lambda command: calls.append(command) or "delete")
    raw["args"]["command"] += " token=planted-secret"
    transport = FakeTransport()
    token = tmp_path / "bridge.token"
    token.write_text("bootstrap")
    client = ScoreClient(token_path=token, transport=transport)
    sender = Sender(client, Spool(client.incarnation, tmp_path / "spool"))
    assert make_hook("post_tool_call", sender)(**raw) is None
    sender.process_once()
    payload = transport.acked[0]["payload"]
    assert calls == [raw["args"]["command"]]
    assert payload["kanbanDenial"]["commandDigest"] == digest(raw["args"]["command"])
    assert "planted-secret" not in json.dumps(payload)
    assert "[redacted]" in payload["args"]["command"]


def test_no_policy_grant_references():
    root = Path(__file__).parents[1]
    forbidden = "approve_" + "permanent"
    # Source only: recorded fixtures keep their original bytes (the L5 spike did call this API).
    for path in [*root.joinpath("score_bridge").glob("*.py"), root / "conftest.py"]:
        assert forbidden not in path.read_text(), path
