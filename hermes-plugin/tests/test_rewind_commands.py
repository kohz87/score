"""PLAN 5.33: the rewind command, run through a fake gateway session store (no Hermes needed)."""
import importlib.util
import sys
import types
from pathlib import Path

import pytest
from score_bridge import hermes_private as stub
from score_bridge.client import ProtocolError, ScoreClient
from score_bridge.commands import CommandPoller, validate_command
from helpers import FakeTransport


@pytest.fixture
def hermes_private(monkeypatch):
    """The real boundary module (the suite stubs it); the poller is pointed at its functions."""
    path = Path(__file__).parents[1] / "score_bridge/hermes_private.py"
    spec = importlib.util.spec_from_file_location("score_bridge._rewind_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(stub, "gateway_session_store", module.gateway_session_store)
    monkeypatch.setattr(stub, "rewind_session", module.rewind_session)
    return module


class FakeStore:
    """Mimics gateway SessionStore.rewind_session: soft-deletes user turns from the end, clamping to the oldest."""

    def __init__(self, turns_by_session):
        self.turns = dict(turns_by_session)
        self.calls = []

    def rewind_session(self, session_id, n=1, **kwargs):
        self.calls.append((session_id, n))
        have = self.turns.get(session_id, 0)
        if have == 0:
            return None
        undone = min(n, have)
        self.turns[session_id] = have - undone
        return {"rewound_count": undone * 3, "turns_undone": undone, "target_text": "secret user text"}


@pytest.fixture
def gateway(monkeypatch):
    store = FakeStore({"score-room-builder": 3})
    runner = types.SimpleNamespace(session_store=store)
    module = types.ModuleType("gateway.run")
    module._gateway_runner_ref = lambda: runner
    monkeypatch.setitem(sys.modules, "gateway.run", module)
    return store


def command(**extra):
    return {"commandId": "c1", "kind": "rewind", "sessionId": "score-room-builder", "turns": 2, **extra}


def test_hermes_private_rewinds_through_the_gateway_store(gateway, hermes_private):
    assert hermes_private.gateway_session_store() is gateway
    assert hermes_private.rewind_session("score-room-builder", 2) == {"turns_undone": 2, "rewound_count": 6}
    # Clamped to the oldest turn, like /undo.
    assert hermes_private.rewind_session("score-room-builder", 5) == {"turns_undone": 1, "rewound_count": 3}
    # Nothing left to rewind.
    assert hermes_private.rewind_session("score-room-builder", 1) is None
    assert hermes_private.rewind_session("unknown", 1) is None
    with pytest.raises(ValueError):
        hermes_private.rewind_session("", 1)
    with pytest.raises(ValueError):
        hermes_private.rewind_session("x", 0)


def test_no_gateway_means_no_store(monkeypatch, hermes_private):
    monkeypatch.delitem(sys.modules, "gateway.run", raising=False)
    assert hermes_private.gateway_session_store() is None
    with pytest.raises(RuntimeError):
        hermes_private.rewind_session("x", 1)
    # A runner reference that is gone, or a store without rewind, is the same as no gateway.
    module = types.ModuleType("gateway.run")
    module._gateway_runner_ref = lambda: None
    monkeypatch.setitem(sys.modules, "gateway.run", module)
    assert hermes_private.gateway_session_store() is None
    module._gateway_runner_ref = lambda: types.SimpleNamespace(session_store=object())
    assert hermes_private.gateway_session_store() is None
    assert hermes_private.available()["gateway.run._gateway_runner_ref"] is False


@pytest.mark.parametrize("bad", [None, [], {}, command(commandId=""), command(kind="other"), command(turns=0),
                                 command(turns=True), command(turns=1001), command(sessionId=""),
                                 command(commandId="x" * 129)])
def test_commands_are_validated(bad):
    with pytest.raises(ProtocolError):
        validate_command(bad)


class CommandTransport(FakeTransport):
    def __init__(self, items):
        super().__init__()
        self.items = items
        self.results = []

    def __call__(self, url, token, body, timeout):
        if "/commands" in url:
            self.calls.append((url, token, body, timeout))
            if url.endswith("/result") and "/commands/" in url:
                self.results.append((url, body))
                return {}
            return {"items": self.items}
        return super().__call__(url, token, body, timeout)


def poller(items):
    transport = CommandTransport(items)
    client = ScoreClient("http://127.0.0.1:1", "/nonexistent", transport, profile="builder")
    client.producer_token, client.expires_at = "producer", 2_000_000_000
    client.enabled = {"gatewayApprovals": False, "kanbanGrants": False, "watch": True}
    client._allow_decisions = False
    return CommandPoller(client), transport


def test_round_trip_reports_hermes_counts_only(gateway, hermes_private):
    command_poller, transport = poller([command()])
    command_poller.process_once()
    assert gateway.calls == [("score-room-builder", 2)]
    assert transport.results == [("http://127.0.0.1:1/bridge/v1/commands/c1/result",
                                  {"outcome": "done", "turnsUndone": 2, "rewoundCount": 6})]
    # The text Hermes echoes back never leaves the process.
    assert "secret" not in repr(transport.results)


def test_a_repeated_command_never_rewinds_twice(gateway, hermes_private):
    command_poller, transport = poller([command()])
    command_poller.process_once()
    command_poller.process_once()
    assert gateway.calls == [("score-room-builder", 2)]
    assert len(transport.results) == 2 and transport.results[0] == transport.results[1]


def test_nothing_to_rewind_and_failures(gateway, hermes_private, monkeypatch):
    command_poller, transport = poller([command(commandId="c2", sessionId="unknown")])
    command_poller.process_once()
    assert transport.results[0][1] == {"outcome": "nothing"}

    def boom(*_):
        raise OSError("db locked: /home/user/.hermes/state.db")
    monkeypatch.setattr(stub, "rewind_session", boom)
    command_poller, transport = poller([command(commandId="c3")])
    command_poller.process_once()
    assert transport.results[0][1] == {"outcome": "failed", "error": "rewind_failed"}


def test_an_invalid_batch_runs_nothing(gateway, hermes_private):
    command_poller, transport = poller([command(), command(commandId="c9", turns=0)])
    with pytest.raises(ProtocolError):
        command_poller.process_once()
    assert gateway.calls == [] and transport.results == []


def test_the_poller_waits_outside_a_gateway(monkeypatch):
    monkeypatch.delitem(sys.modules, "gateway.run", raising=False)
    command_poller, transport = poller([command()])
    command_poller.stop_event.set()
    command_poller._run()
    assert transport.calls == []
