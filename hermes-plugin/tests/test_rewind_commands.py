"""PLAN 5.33: the rewind command, run through a fake gateway session store (no Hermes needed)."""
import importlib.util
import sys
import threading
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

    def _owner_key_for_session_id(self, session_id):
        return "agent:main:" + session_id  # a session the gateway's routing index knows

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


class RowsDb:
    """Rows of one session; the repaired projection merges consecutive user rows into one turn (like Hermes)."""

    def __init__(self, rows):
        self.rows = rows  # [role, timestamp, active] or [role, timestamp, active, display_kind]

    def get_messages_as_conversation(self, session_id, repair_alternation=False, include_row_ids=False, **_):
        out = []
        for role, stamp, active, *kind in self.rows:
            if not active:
                continue
            if repair_alternation and role == "user" and out and out[-1]["role"] == "user":
                continue
            out.append({"role": role, "timestamp": stamp, **({"display_kind": kind[0]} if kind else {})})
        return out

    def rewind_user_turn(self, session_id, ordinal, **_):
        n = -ordinal
        users = [i for i, row in enumerate(self.rows) if row[0] == "user" and row[2]]
        # Mirror the repaired count: consecutive user rows are one turn.
        groups = []
        for i in users:
            if groups and all(self.rows[j][0] == "user" or not self.rows[j][2] for j in range(groups[-1][-1], i)):
                groups[-1].append(i)
            else:
                groups.append([i])
        for group in groups[-n:]:
            for i in range(group[0], len(self.rows)):
                self.rows[i][2] = False
        return types.SimpleNamespace(rewound_count=2, turns_undone=min(n, len(groups)))


class RowsStore:
    """A gateway session store; ``indexed=False`` is a session its routing index doesn't know (an API session)."""

    def __init__(self, db, broken=False, indexed=True):
        self.db, self.broken, self.indexed, self.calls = db, broken, indexed, []

    def _owner_key_for_session_id(self, session_id):
        return "agent:main:s" if self.indexed else None

    def _db_for_session_id(self, session_id):
        return self.db

    def _get_transcript_drain_lock(self):
        return threading.Lock()

    def rewind_session(self, session_id, n=1, **_):
        self.calls.append(n)
        if self.broken:
            return {"rewound_count": 1, "turns_undone": n}
        outcome = self.db.rewind_user_turn(session_id, -n)
        return {"rewound_count": outcome.rewound_count, "turns_undone": outcome.turns_undone}


def install(monkeypatch, store):
    runner = types.SimpleNamespace(session_store=store)
    module = types.ModuleType("gateway.run")
    module._gateway_runner_ref = lambda: runner
    monkeypatch.setitem(sys.modules, "gateway.run", module)
    # Hermes's own user-turn rule (agent.context_compressor.user_originated_turn_view): a typed /steer row counts,
    # other display kinds are synthetic.
    compressor = types.ModuleType("agent.context_compressor")
    compressor.user_originated_turn_view = lambda m: (
        m if m.get("role") == "user" and m.get("display_kind") in (None, "steer") else None)
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.context_compressor", compressor)


def test_rewind_target_is_absolute_when_a_turn_had_no_reply(monkeypatch, hermes_private):
    # u1 a1 | u2 a2 | u3 (no reply) | u4 a4 | u5 a5: Score has runs for u2, u4 and u5 only; the person's message is u4.
    db = RowsDb([["user", 100, True], ["assistant", 101, True], ["user", 200, True], ["assistant", 201, True],
                 ["user", 300, True], ["user", 400, True], ["assistant", 401, True],
                 ["user", 500, True], ["assistant", 501, True]])
    store = RowsStore(db)
    install(monkeypatch, store)
    # Hermes counts u3+u4 as one repaired turn, so the message u4 (400) shares a turn with the unanswered u3: refused.
    with pytest.raises(ValueError):
        hermes_private.rewind_session("s", 2, 400)
    assert store.calls == []
    # Anchored on u5 the turns from `since` are exactly one, whatever Score counted.
    result = hermes_private.rewind_session("s", 3, 500)
    assert store.calls == [1] and result == {"turns_undone": 1, "rewound_count": 2}
    assert [row[2] for row in db.rows] == [True] * 7 + [False, False]


def test_rewind_refuses_when_no_turn_since_or_still_active(monkeypatch, hermes_private):
    db = RowsDb([["user", 100, True], ["assistant", 101, True]])
    install(monkeypatch, RowsStore(db))
    with pytest.raises(ValueError):
        hermes_private.rewind_session("s", 1, 500)
    db = RowsDb([["user", 100, True], ["assistant", 101, True], ["user", 600, True], ["assistant", 601, True]])
    install(monkeypatch, RowsStore(db, broken=True))
    with pytest.raises(RuntimeError):
        hermes_private.rewind_session("s", 1, 500)


def test_since_is_validated():
    base = command()
    validate_command({**base, "since": 1_790_000_000.5})
    for bad in (0, -1, "x", True, 1e13):
        with pytest.raises(ProtocolError):
            validate_command({**base, "since": bad})


def test_a_steer_row_after_the_message_counts_as_a_turn_like_hermes(monkeypatch, hermes_private):
    # u1 a1 | u2 a2 | steer a3: anchored on u2, Hermes undoes two turns (u2 and the steer), so the plugin must ask for two.
    db = RowsDb([["user", 100, True], ["assistant", 101, True], ["user", 200, True], ["assistant", 201, True],
                 ["user", 300, True, "steer"], ["assistant", 301, True]])
    store = RowsStore(db)
    install(monkeypatch, store)
    hermes_private.rewind_session("s", 1, 200)
    assert store.calls == [2]


def test_an_api_session_of_a_named_profile_is_rewound_in_that_profiles_own_store(monkeypatch, hermes_private):
    # A multiplexed gateway's store doesn't index API-server sessions and would fall back to the root store: the
    # plugin rewinds in the profile's own store from Hermes's registry instead, and releases the handle.
    db = RowsDb([["user", 100, True], ["assistant", 101, True], ["user", 200, True], ["assistant", 201, True]])
    store = RowsStore(RowsDb([]), indexed=False)
    install(monkeypatch, store)
    acquired, released = [], []
    profiles = types.ModuleType("hermes_cli.profiles")
    profiles.get_profile_dir = lambda name: Path("/hermes/profiles") / name
    registry = types.ModuleType("hermes_state_registry")
    registry.acquire = lambda path: acquired.append(path) or db
    registry.release_or_close = lambda handle: released.append(handle)
    rewind = types.ModuleType("hermes_state_rewind")
    rewind.RewindTargetUnavailableError = type("RewindTargetUnavailableError", (Exception,), {})
    for name, module in (("hermes_cli.profiles", profiles), ("hermes_state_registry", registry),
                         ("hermes_state_rewind", rewind)):
        monkeypatch.setitem(sys.modules, name, module)
    assert hermes_private.rewind_session("s", 1, 200, "scoretesta") == {"turns_undone": 1, "rewound_count": 2}
    assert acquired == [Path("/hermes/profiles/scoretesta/state.db")] and released == [db]
    assert store.calls == [] and [row[2] for row in db.rows] == [True, True, False, False]
