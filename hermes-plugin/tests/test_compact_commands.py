"""PLAN 5.36: the compact command, run through fakes of Hermes's compressor, agent and session store (no Hermes)."""
import importlib.util
import sys
import threading
import time
import types
from pathlib import Path

import pytest
from score_bridge import hermes_private as stub
from score_bridge.client import ProtocolError, ScoreClient
from score_bridge.commands import CommandPoller, validate_command
from helpers import FakeTransport


@pytest.fixture
def hermes_private(monkeypatch):
    path = Path(__file__).parents[1] / "score_bridge/hermes_private.py"
    spec = importlib.util.spec_from_file_location("score_bridge._compact_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ("gateway_session_store", "compact_session", "context_breakdown", "CommandExpired", "CompactLockHeld", "SessionBusy",
                 "CompactUnsupported", "CompactNotPersisted"):
        monkeypatch.setattr(stub, name, getattr(module, name), raising=False)
    CURRENT.append(module)
    return module


CURRENT = []


class FakeDb:
    def __init__(self, count=12, session_row=None):
        self.rows = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"text {i}", "_row_id": i}
                     for i in range(count)]
        self.reads = []
        self.session_row = session_row
        self.published = set()  # child ids written by Hermes's atomic publish
        self.replaced = []
        self.replace_error = None

    def get_messages_as_conversation(self, session_id, include_row_ids=False, **_):
        self.reads.append((session_id, include_row_ids))
        return list(self.rows)

    def get_session(self, session_id):
        if session_id in self.published:
            return {"id": session_id, "parent_session_id": "score-room-builder"}
        return self.session_row

    def _is_compression_child_row(self, child):
        return child.get("parent_session_id") is not None

    def get_active_message_watermark(self, session_id):
        return 5 if session_id in self.published else 0

    def replace_messages(self, session_id, messages, active_only=False, **_):
        if self.replace_error:
            raise self.replace_error
        self.replaced.append((session_id, list(messages), active_only))


class FakeStore:
    def __init__(self):
        self.lock, self.depth = threading.RLock(), 0

    def rewind_session(self, *_, **__):  # makes it a session store for gateway_session_store()
        return None

    def _get_transcript_drain_lock(self):
        store = self

        class Held:
            def __enter__(self):
                store.lock.acquire()
                store.depth += 1

            def __exit__(self, *_):
                store.depth -= 1
                store.lock.release()
        return Held()


class Rig:
    """Everything compact_session reaches for, as modules in sys.modules."""

    def __init__(self, monkeypatch, db=None, status="compressed", runtime=None, multiplex=False,
                 mode="rotated", summary="Goal: ship the report. Decision: use the monthly index.", fallback_row=None):
        # _lookup caches Hermes callables per module: a second rig in one test must not see the first one's.
        CURRENT[-1]._lookup.cache_clear()
        CURRENT[-1]._lookup_attr.cache_clear()
        self.db, self.store = db or FakeDb(), FakeStore()
        self.status, self.events, self.agents, self.compress_calls = status, [], [], []
        self.summary, self.fallback_row = summary, fallback_row
        self.mode = mode  # rotated (published child), rotated_bare, inplace, unchanged
        self.released, self.acquired, self.scopes = [], [], []
        self.depth_seen = []
        self.running = {}
        rig = self

        class Runner:
            session_store = self.store
            config = types.SimpleNamespace(multiplex_profiles=multiplex)
            _running_agents = self.running

            def _resolve_session_agent_runtime(self, **_):
                return "model-x", dict(runtime if runtime is not None else {"api_key": "k", "api_mode": "chat"})

            def _resolve_session_reasoning_config(self, **_):
                return {"effort": "low"}

        class Scope:
            def __init__(self, home):
                self.home = home

            def __enter__(self):
                rig.scopes.append(("enter", self.home))

            def __exit__(self, *_):
                rig.scopes.append(("exit", self.home))

        gateway = types.ModuleType("gateway.run")
        gateway._gateway_runner_ref = lambda: Runner()
        gateway._profile_runtime_scope = Scope
        gateway._GATEWAY_HYGIENE_PLATFORM = "hygiene"
        gateway._seed_hygiene_system_prompt = lambda agent, row: self.events.append(("seed", row))

        class Agent:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.session_id = kwargs["session_id"]
                self.closed = False
                rig.agents.append(self)

            def close(self):
                self.closed = True

        run_agent = types.ModuleType("run_agent")
        run_agent.AIAgent = Agent

        manual = types.ModuleType("agent.conversation_compression_manual")
        manual.MIN_MESSAGES = 4

        class CompressRequest:
            def __init__(self, partial=False, keep_last=2):
                self.partial, self.keep_last = partial, keep_last
        manual.CompressRequest = CompressRequest

        def compress_now(agent, messages, request, **kwargs):
            rig.depth_seen.append(rig.store.depth)
            rig.compress_calls.append((agent, messages, request, kwargs))
            if rig.status == "compressed":
                if rig.summary is not None:
                    agent.context_compressor = types.SimpleNamespace(_previous_summary=rig.summary)
                if rig.mode in ("rotated", "rotated_bare"):
                    agent.session_id = "child-1"
                    if rig.mode == "rotated":
                        rig.db.published.add("child-1")
                elif rig.mode == "inplace":
                    agent._last_compaction_in_place = True
                if rig.mode == "noop":
                    return types.SimpleNamespace(status="compressed", before_messages=messages,
                                                 after_messages=list(messages), before_tokens=5, after_tokens=5)
                kept = messages[-request.keep_last * 2:] if request.partial else messages[-2:]
                return types.SimpleNamespace(status="compressed", before_messages=messages,
                                             after_messages=[rig.fallback_row or {"role": "user", "content": "summary"}, *kept],
                                             before_tokens=54000, after_tokens=9000)
            return types.SimpleNamespace(status=rig.status, before_messages=messages, after_messages=messages,
                                         before_tokens=1, after_tokens=1)
        manual.compress_now = compress_now

        notify = types.ModuleType("agent.conversation_compression")
        notify.finalize_context_engine_compression_notification = (
            lambda agent, committed: self.events.append(("finalize", committed)))

        profiles = types.ModuleType("hermes_cli.profiles")
        profiles.get_profile_dir = lambda name: Path("/hermes/profiles") / name
        registry = types.ModuleType("hermes_state_registry")
        registry.acquire = lambda path: self.acquired.append(path) or self.db
        registry.release_or_close = lambda handle: self.released.append(handle)
        breakdown = types.ModuleType("agent.context_breakdown")

        def compute(agent, messages):
            rig.events.append(("breakdown", len(messages)))
            return {"categories": [{"id": "system_prompt", "label": "System prompt", "tokens": 3000},
                                   {"id": "conversation", "label": "Messages", "tokens": 20000},
                                   {"id": "weird", "label": "Not ours", "tokens": 5}],
                    "context_max": 128000, "context_used": 30000, "context_source": "provider_usage",
                    "model": "model-x", "secret": "never forwarded"}
        breakdown.compute_session_context_breakdown = compute
        for name, module in (("agent.context_breakdown", breakdown), ("gateway.run", gateway), ("run_agent", run_agent), ("agent", types.ModuleType("agent")),
                             ("agent.conversation_compression_manual", manual),
                             ("agent.conversation_compression", notify), ("hermes_cli.profiles", profiles),
                             ("hermes_state_registry", registry)):
            monkeypatch.setitem(sys.modules, name, module)


def command(**extra):
    return {"commandId": "k1", "kind": "compact", "sessionId": "score-room-builder", "keepRecent": 3,
            "expiresAt": time.time() + 180, **extra}


def test_compacts_the_profiles_own_session_under_the_transcript_lock(monkeypatch, hermes_private):
    rig = Rig(monkeypatch)
    result = hermes_private.compact_session("score-room-builder", 3, "scoretesta", expires_at=time.time() + 60)
    assert result == {"before": {"messages": 12, "tokens": 54000}, "after": {"messages": 7, "tokens": 9000},
                      "rotated": True, "newSessionId": "child-1",
                      "summary": "Goal: ship the report. Decision: use the monthly index."}
    # Worked in the profile's own store, under the transcript lock, and released the handle.
    assert rig.acquired == [Path("/hermes/profiles/scoretesta/state.db")] and rig.released == [rig.db]
    assert rig.depth_seen == [1]
    agent, messages, request, kwargs = rig.compress_calls[0]
    assert request.partial is True and request.keep_last == 3 and len(messages) == 12
    assert kwargs == {"system_message": "", "skip_without_window": True, "task_id": "score-room-builder"}
    assert agent.kwargs["session_id"] == "score-room-builder" and agent.kwargs["session_db"] is rig.db
    assert agent.kwargs["reasoning_config"] == {"effort": "low"} and agent.kwargs["gateway_session_key"]
    assert agent.platform == "hygiene" and agent._end_session_on_close is False and agent.closed
    assert ("finalize", True) in rig.events and ("finalize", False) not in rig.events


def test_nothing_changed_is_reported_as_nothing(monkeypatch, hermes_private):
    rig = Rig(monkeypatch, mode="noop")
    assert hermes_private.compact_session("s", None, "p") is None
    assert ("finalize", True) not in rig.events and rig.db.replaced == []


def test_without_keep_recent_hermes_compresses_in_full(monkeypatch, hermes_private):
    rig = Rig(monkeypatch)
    hermes_private.compact_session("s", None, "scoretesta")
    assert rig.compress_calls[0][2].partial is False


def test_a_short_session_or_nothing_to_do_is_nothing(monkeypatch, hermes_private):
    rig = Rig(monkeypatch, db=FakeDb(count=3))
    assert hermes_private.compact_session("s", None, "p") is None
    assert rig.compress_calls == [] and rig.agents == [] and rig.released == [rig.db]
    rig = Rig(monkeypatch, status="nothing_to_do")
    assert hermes_private.compact_session("s", None, "p") is None
    assert ("finalize", False) in rig.events and rig.agents[0].closed


def test_a_held_compression_lock_is_reported(monkeypatch, hermes_private):
    rig = Rig(monkeypatch, status="lock_skipped")
    with pytest.raises(hermes_private.CompactLockHeld):
        hermes_private.compact_session("s", None, "p")
    assert ("finalize", False) in rig.events and rig.released == [rig.db]


def test_a_running_session_unsupported_runtimes_and_missing_gateway_are_refused(monkeypatch, hermes_private):
    rig = Rig(monkeypatch)
    rig.running["agent:main:s:1"] = object()
    with pytest.raises(hermes_private.SessionBusy):
        hermes_private.compact_session("s", None, "p")
    assert rig.acquired == [] and rig.compress_calls == []
    for runtime in ({"api_key": "k", "api_mode": "codex_app_server"}, {"api_mode": "chat"}):
        rig = Rig(monkeypatch, runtime=runtime)
        with pytest.raises(hermes_private.CompactUnsupported):
            hermes_private.compact_session("s", None, "p")
        assert rig.compress_calls == [] and rig.released == [rig.db]
    monkeypatch.delitem(sys.modules, "gateway.run")
    with pytest.raises(RuntimeError):
        hermes_private.compact_session("s", None, "p")
    with pytest.raises(ValueError):
        Rig(monkeypatch) and hermes_private.compact_session("", None, "p")
    with pytest.raises(ValueError):
        hermes_private.compact_session("s", 21, "p")


def test_a_multiplexed_gateway_gets_the_profile_scope(monkeypatch, hermes_private):
    rig = Rig(monkeypatch, multiplex=True)
    hermes_private.compact_session("s", None, "scoretesta")
    assert rig.scopes == [("enter", Path("/hermes/profiles/scoretesta")), ("exit", Path("/hermes/profiles/scoretesta"))]


def test_an_expired_command_never_touches_hermes(monkeypatch, hermes_private):
    rig = Rig(monkeypatch)
    with pytest.raises(hermes_private.CommandExpired):
        hermes_private.compact_session("s", None, "p", expires_at=time.time() - 1)
    assert rig.compress_calls == [] and rig.agents == [] and rig.released == [rig.db]


@pytest.mark.parametrize("bad", [command(keepRecent=0), command(keepRecent=21), command(keepRecent=True),
                                 command(keepRecent="2"), command(sessionId=""), command(expiresAt=None),
                                 command(kind="other")])
def test_compact_commands_are_validated(bad):
    with pytest.raises(ProtocolError):
        validate_command(bad)


def test_valid_compact_commands():
    validate_command(command())
    validate_command({k: v for k, v in command().items() if k != "keepRecent"})


class CommandTransport(FakeTransport):
    def __init__(self, items):
        super().__init__()
        self.items, self.results = items, []

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
    client = ScoreClient("http://127.0.0.1:1", "/nonexistent", transport, profile="scoretesta")
    client.producer_token, client.expires_at = "producer", 2_000_000_000
    client.enabled = {"gatewayApprovals": False, "kanbanGrants": False, "watch": True}
    client._allow_decisions = False
    return CommandPoller(client), transport


def test_round_trip_reports_counts_only_and_runs_once(monkeypatch, hermes_private):
    rig = Rig(monkeypatch)
    command_poller, transport = poller([command()])
    command_poller.process_once()
    command_poller.process_once()
    assert len(rig.compress_calls) == 1
    expected = {"outcome": "done", "before": {"messages": 12, "tokens": 54000},
                "after": {"messages": 7, "tokens": 9000},
                "summary": "Goal: ship the report. Decision: use the monthly index."}  # rotated/newSessionId stay in the plugin
    assert [body for _, body in transport.results] == [expected, expected]
    assert "text 1" not in repr(transport.results)


def test_the_summary_is_redacted_and_capped(monkeypatch, hermes_private):
    secret = "sk-" + "a1B2c3D4" * 5
    Rig(monkeypatch, summary=f"Key was {secret}. " + "word " * 20000)
    summary = hermes_private.compact_session("s", None, "p")["summary"]
    assert secret not in summary
    assert len(summary.encode()) < 33 * 1024 and summary.endswith("longer than 32 KB.]")


def test_the_summary_falls_back_to_the_flagged_compressed_row(monkeypatch, hermes_private):
    row = {"role": "user", "_compressed_summary": True,
           "content": "[CONTEXT COMPACTION] handoff.\nBody of the summary.\n--- END OF CONTEXT SUMMARY — respond ---"}
    Rig(monkeypatch, summary=None, fallback_row=row)
    assert hermes_private.compact_session("s", None, "p")["summary"] == "[CONTEXT COMPACTION] handoff.\nBody of the summary."


def test_no_summary_text_is_none_and_not_reported(monkeypatch, hermes_private):
    Rig(monkeypatch, summary=None)
    assert hermes_private.compact_session("s", None, "p")["summary"] is None
    rig = Rig(monkeypatch, summary=None)
    command_poller, transport = poller([command()])
    command_poller.process_once()
    assert "summary" not in transport.results[0][1]


@pytest.mark.parametrize("status,error", [("lock_skipped", "lock_held")])
def test_failures_use_fixed_error_codes(monkeypatch, hermes_private, status, error):
    Rig(monkeypatch, status=status)
    command_poller, transport = poller([command()])
    command_poller.process_once()
    assert transport.results[0][1] == {"outcome": "failed", "error": error}


def test_an_unpersisted_compaction_is_reported_with_a_fixed_code(monkeypatch, hermes_private):
    Rig(monkeypatch, mode="unchanged")
    command_poller, transport = poller([command(commandId="np")])
    command_poller.process_once()
    assert transport.results[0][1] == {"outcome": "failed", "error": "not_persisted"}


def test_unexpected_errors_never_leak_hermes_text(monkeypatch, hermes_private):
    rig = Rig(monkeypatch)

    def boom(*_, **__):
        raise OSError("db locked: /home/user/.hermes/state.db")
    monkeypatch.setitem(sys.modules, "agent.conversation_compression_manual",
                        types.SimpleNamespace(MIN_MESSAGES=4, CompressRequest=lambda **kw: None, compress_now=boom))
    command_poller, transport = poller([command(commandId="k2")])
    command_poller.process_once()
    assert transport.results[0][1] == {"outcome": "failed", "error": "compact_failed"}
    assert rig.released == [rig.db]


def test_busy_and_expired_and_nothing_outcomes(monkeypatch, hermes_private):
    rig = Rig(monkeypatch)
    rig.running["x:score-room-builder"] = 1
    command_poller, transport = poller([command(commandId="b")])
    command_poller.process_once()
    assert transport.results[0][1] == {"outcome": "failed", "error": "session_busy"}
    rig = Rig(monkeypatch)
    command_poller, transport = poller([command(commandId="e", expiresAt=time.time() - 1)])
    command_poller.process_once()
    assert transport.results[0][1] == {"outcome": "expired"} and rig.compress_calls == []
    Rig(monkeypatch, db=FakeDb(count=2))
    command_poller, transport = poller([command(commandId="n")])
    command_poller.process_once()
    assert transport.results[0][1] == {"outcome": "nothing"}


def test_context_breakdown_reads_hermes_accounting_without_a_model_call(monkeypatch, hermes_private):
    rig = Rig(monkeypatch)
    result = hermes_private.context_breakdown("score-room-builder", "scoretesta")
    assert result == {"window": 128000, "used": 30000, "model": "model-x", "source": "provider_usage",
                      "autoCompactAt": None,
                      "parts": [{"kind": "system_prompt", "label": "System prompt", "tokens": 3000},
                                {"kind": "conversation", "label": "Messages", "tokens": 20000}]}
    assert ("breakdown", 12) in rig.events and rig.compress_calls == []
    assert rig.agents[0].closed and rig.released == [rig.db]


def test_context_breakdown_threshold_and_empty_session(monkeypatch, hermes_private):
    rig = Rig(monkeypatch)
    original = hermes_private._build_compression_agent

    def with_compressor(*args):
        agent = original(*args)
        agent.context_compressor = types.SimpleNamespace(threshold_tokens=64000)
        return agent
    monkeypatch.setattr(hermes_private, "_build_compression_agent", with_compressor)
    assert hermes_private.context_breakdown("s", "p")["autoCompactAt"] == 64000
    rig = Rig(monkeypatch, db=FakeDb(count=0))
    assert hermes_private.context_breakdown("s", "p") is None and rig.agents == []


def test_context_command_round_trip(monkeypatch, hermes_private):
    Rig(monkeypatch)
    command_poller, transport = poller([{"commandId": "q1", "kind": "context_breakdown",
                                         "sessionId": "score-room-builder", "expiresAt": time.time() + 20}])
    command_poller.process_once()
    body = transport.results[0][1]
    assert body["outcome"] == "done" and body["context"]["used"] == 30000 and "secret" not in repr(body)
    Rig(monkeypatch, db=FakeDb(count=0))
    command_poller, transport = poller([{"commandId": "q2", "kind": "context_breakdown", "sessionId": "s",
                                         "expiresAt": time.time() + 20}])
    command_poller.process_once()
    assert transport.results[0][1] == {"outcome": "nothing"}
