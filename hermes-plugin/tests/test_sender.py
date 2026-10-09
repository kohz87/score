import json
import threading
import time
from urllib.error import HTTPError

import pytest

import score_bridge
from score_bridge.client import ScoreClient
from score_bridge.sender import Sender
from score_bridge.spool import Spool
from helpers import FakeTransport, make_hook


@pytest.fixture
def setup(tmp_path):
    token = tmp_path / "bridge.token"
    token.write_text("bootstrap")
    transport = FakeTransport()
    client = ScoreClient(token_path=token, transport=transport)
    sender = Sender(client, Spool(client.incarnation, tmp_path / "spool"))
    return sender, transport


def enqueue(sender, count, **payload):
    for _ in range(count):
        make_hook("pre_tool_call", sender)(**payload)


def test_bounded_queue_drops_oldest_once(setup):
    sender, transport = setup
    enqueue(sender, 10_001)
    assert sender.queue.qsize() == 10_000 and sender.dropped == 1
    sender.process_once()
    assert transport.acked[0]["hook"] == "bridge.gap"
    assert transport.acked[0]["payload"] == {"from_counter": 1, "to_counter": 1, "dropped": 1}
    assert [e["counter"] for e in transport.acked] == list(range(2, 10_003))
    assert all(len(batch) <= 200 for batch in transport.event_calls)


def test_score_down_then_ordered_reconnect(setup):
    sender, transport = setup
    transport.down = True
    enqueue(sender, 425, session_key="s", session_id="id", tool_call_id="tool")
    sender.process_once()
    assert sender.spool.path.exists() and transport.acked == []
    lines = [json.loads(line)["events"] for line in sender.spool.path.read_text().splitlines()]
    assert [len(line) for line in lines] == [200, 200, 25]
    transport.down = False
    enqueue(sender, 20)
    sender.process_once()
    assert [e["counter"] for e in transport.acked] == list(range(1, 446))
    assert transport.acked[0]["sessionKey"] == "s"
    assert transport.acked[0]["sessionId"] == "id" and transport.acked[0]["toolCallId"] == "tool"
    assert not sender.spool.path.exists()


def test_missing_token_spools_without_network(tmp_path):
    transport = FakeTransport()
    client = ScoreClient(token_path=tmp_path / "missing", transport=transport)
    sender = Sender(client, Spool(client.incarnation, tmp_path / "spool"))
    enqueue(sender, 10)
    sender.process_once()
    assert sender.spool.path.exists() and transport.calls == []


def test_partial_ack_preserves_unacked_suffix(setup):
    sender, transport = setup
    enqueue(sender, 5)
    transport.ack_limit = 2
    sender.process_once()
    assert [e["counter"] for e in sender.spool.peek()] == [3, 4, 5]
    transport.ack_limit = None
    sender.process_once()
    assert [e["counter"] for e in transport.acked] == [1, 2, 3, 4, 5]


def test_ack_beyond_batch_does_not_prevent_replay_progress(setup):
    sender, transport = setup
    transport.ack_limit = 999
    enqueue(sender, 2)
    sender.process_once()
    assert sender.spool.peek() == []


def test_hook_no_network_or_repr_and_never_raises(setup):
    sender, transport = setup
    class Bad:
        def __repr__(self):
            raise RuntimeError("secret")
    class BadDict(dict):
        def items(self):
            raise RuntimeError("secret")
    wrapper = make_hook("post_tool_call", sender)
    assert wrapper(result=Bad(), args=BadDict()) is None
    assert transport.calls == []
    sender.process_once()
    assert transport.acked[0]["payload"]["result"] == "<Bad>"


def test_slow_transport_cannot_block_hook_or_shutdown(setup):
    sender, _ = setup
    started = threading.Event()
    released = threading.Event()
    def slow(*args):
        started.set()
        released.wait(5)
        raise TimeoutError()
    sender.client.transport = slow
    sender.start()
    enqueue(sender, 100)
    assert started.wait(2)
    wrapper = make_hook("pre_tool_call", sender)
    start = time.perf_counter()
    wrapper(command="echo hello")
    elapsed = time.perf_counter() - start
    assert elapsed < 0.001
    try:
        start = time.monotonic()
        sender.shutdown(budget=0.2)
        assert time.monotonic() - start < 0.4
        all_events = [e for line in sender.spool.path.read_text().splitlines() for e in json.loads(line)["events"]]
        assert [e["counter"] for e in all_events] == list(range(1, 102))
    finally:
        released.set()
        sender._thread.join(2)


def test_periodic_and_threshold_flush(setup):
    sender, transport = setup
    sender.start()
    try:
        enqueue(sender, 1)
        deadline = time.monotonic() + 2
        while not transport.acked and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(transport.acked) == 1
        enqueue(sender, 100)
        deadline = time.monotonic() + 2
        while len(transport.acked) < 101 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(transport.acked) == 101
    finally:
        sender.shutdown()


def test_error_ring_is_bounded_and_contains_no_raw_errors(setup, monkeypatch):
    sender, _ = setup
    def broken(*args):
        raise RuntimeError("token=secret")
    monkeypatch.setattr(sender, "enqueue", broken)
    wrapper = make_hook("post_tool_call", sender)
    for _ in range(150):
        assert wrapper() is None
    assert len(sender.errors) == 100
    assert all(error == "hook:post_tool_call" for error in sender.errors)


def test_register_hooks_once_per_process_and_independent_failures(setup, monkeypatch):
    sender, _ = setup
    monkeypatch.setattr(score_bridge, "_sender", sender)
    monkeypatch.setattr(score_bridge, "_pid", __import__("os").getpid())
    class Context:
        hooks = {}
        def register_hook(self, name, wrapper):
            if name == "pre_tool_call":
                raise ValueError()
            self.hooks[name] = wrapper
    ctx = Context()
    score_bridge.register(ctx)
    assert len(ctx.hooks) == len(score_bridge.HOOKS) - 1
    assert sender._closed
    assert "register:pre_tool_call" in score_bridge._sender.errors
    score_bridge._sender.shutdown()
    __import__("atexit").unregister(score_bridge._exit_callback)


def test_disk_error_is_fail_open_and_becomes_gap(setup, monkeypatch):
    sender, _ = setup
    enqueue(sender, 2)
    append = sender.spool.append
    monkeypatch.setattr(sender.spool, "append", lambda events, **kwargs: (_ for _ in ()).throw(OSError()))
    sender.process_once()
    assert sender.dropped == 2
    monkeypatch.setattr(sender.spool, "append", append)
    sender.process_once()
    assert "spool" in sender.errors


def test_json_encoder_failure_cannot_escape_hook_or_sender(setup, monkeypatch):
    from score_bridge import spool as module
    sender, _ = setup
    def broken(*args, **kwargs):
        raise RuntimeError("password=raw-secret")
    monkeypatch.setattr(module.json, "dumps", broken)
    assert make_hook("post_tool_call", sender)(result=object()) is None
    sender.process_once()
    assert "spool" in sender.errors
    assert sender.dropped == 1
    sender.process_once()
    assert sender.dropped == 1


def test_lost_ack_then_eviction_uses_fresh_gap_counter(tmp_path):
    token = tmp_path / "token"
    token.write_text("bootstrap")
    received = {}
    counter_calls = []
    down = [True]
    def transport(url, bearer, body, timeout):
        if url.endswith("hello"):
            return FakeTransport()(url, bearer, body, timeout)
        for event in body["events"]:
            counter = event["counter"]
            counter_calls.append(counter)
            assert counter not in received or received[counter] == event
            received[counter] = event
        if down[0]:
            raise TimeoutError("response lost after ingestion")
        return {"ackedThrough": body["events"][-1]["counter"]}
    client = ScoreClient(token_path=token, transport=transport)
    sender = Sender(client, Spool(client.incarnation, tmp_path / "spool", file_cap=3000, directory_cap=5000))
    for _ in range(6):
        enqueue(sender, 1, result="x" * 700)
        sender.process_once()
    down[0] = False
    sender.process_once()
    gaps = [event for event in received.values() if event["hook"] == "bridge.gap"]
    assert gaps
    assert all(event["counter"] > event["payload"]["to_counter"] for event in gaps)
    assert not sender.spool.path.exists()

    previous = max(received)
    enqueue(sender, 1, command="echo after recovery")
    sender.process_once()
    assert max(received) > previous


def test_large_backlog_splits_by_actual_http_body_bytes(setup):
    sender, transport = setup
    enqueue(sender, 40, result={f"part{i}": "x" * 10_000 for i in range(6)})
    sender.process_once()
    assert [event["counter"] for event in transport.acked] == list(range(1, 41))
    assert len(transport.event_calls) > 1
    for events in transport.event_calls:
        assert len(events) <= 200
        assert len(json.dumps({"events": events}, allow_nan=False).encode("utf-8")) <= 1.5 * 1024 * 1024
    assert not sender.spool.path.exists()


def test_byte_split_stops_at_first_failure_and_retries_remaining_events(setup):
    sender, transport = setup
    attempts = []
    failing = [True]
    def fail_second(url, bearer, body, timeout):
        if url.endswith("/events"):
            attempts.append(body["events"])
            if len(attempts) == 2 and failing[0]:
                raise ConnectionRefusedError()
        return transport(url, bearer, body, timeout)
    sender.client.transport = fail_second
    enqueue(sender, 80, result={f"part{i}": "x" * 10_000 for i in range(6)})
    sender.process_once()
    assert len(attempts) == 2
    assert transport.acked
    last = transport.acked[-1]["counter"]
    assert sender.spool.peek()[0]["counter"] == last + 1
    failing[0] = False
    sender.process_once()
    assert [event["counter"] for event in transport.acked] == list(range(1, 81))
    assert attempts[2][0]["counter"] == last + 1
    assert not sender.spool.path.exists()


def test_byte_budget_counts_encoder_unicode_escaping(setup):
    sender, transport = setup
    # UTF-8 spool bytes fit while the HTTP encoder's ensure_ascii expansion requires splitting.
    enqueue(sender, 40, result={f"part{i}": "é" * 5_000 for i in range(4)})
    sender.process_once()
    assert [event["counter"] for event in transport.acked] == list(range(1, 41))
    assert len(transport.event_calls) > 1
    assert all(len(json.dumps({"events": events}, allow_nan=False).encode("utf-8")) <= 1.5 * 1024 * 1024
               for events in transport.event_calls)


def test_gate_05_evicted_prefix_does_not_block_retained_batches_or_gap(setup):
    from score_bridge.spool import encode, gap_event
    sender, _ = setup
    def event(counter):
        return {"counter": counter, "hook": "on_session_start", "at": "2026-10-07T00:00:00Z",
                "sessionKey": None, "sessionId": None, "toolCallId": None, "payload": {}}
    sender.spool.directory.mkdir(mode=0o700, exist_ok=True)
    sender.spool.path.write_bytes(encode([event(2)]) + encode([event(3)]) +
        encode([gap_event(1, 1, "2026-10-07T00:00:00Z")], pending_gap=True))
    received, ack = set(), 0
    batches = []
    class Client:
        profile = sender.client.profile
        def send(self, events):
            nonlocal ack
            batches.append([e["counter"] for e in events])
            for e in events:
                received.add(e["counter"])
                if e["hook"] == "bridge.gap":
                    received.update(range(e["payload"]["from_counter"], e["payload"]["to_counter"] + 1))
            while ack + 1 in received:
                ack += 1
            if ack == 0:
                assert sender.spool.peek()[0]["counter"] == 2
            return ack
    assert sender._drain(sender.spool, Client())
    assert batches == [[2], [3], [4]] and ack == 4
    assert sender.spool.peek() == []


def test_gate_05_drain_caps_a_cycle_at_twenty_batches_and_retains_unacked(setup):
    from score_bridge.spool import encode
    sender, transport = setup
    records = [{"counter": i, "hook": "on_session_start", "at": "2026-10-07T00:00:00Z",
                "sessionKey": None, "sessionId": None, "toolCallId": None, "payload": {}} for i in range(1, 26)]
    sender.spool.directory.mkdir(mode=0o700, exist_ok=True)
    sender.spool.path.write_bytes(b"".join(encode([e]) for e in records))
    transport.ack_limit = 0
    assert sender._drain()
    assert len(transport.event_calls) == 20
    assert sender.spool.peek()[0]["counter"] == 1
    assert sender._drain()
    assert [batch[0]["counter"] for batch in transport.event_calls] == list(range(1, 26))
    assert sender.spool.peek()[0]["counter"] == 1


def test_gate_07_envelope_and_gate_identifiers_are_lifted_before_scrub(setup, monkeypatch):
    from score_bridge import hermes_private
    sender, transport = setup
    monkeypatch.setattr(hermes_private, "redact", lambda text: "[redacted]")
    sender.enqueue("on_session_start", (), {"session_key": "sk-structural123456", "session_id": "session-a",
        "tool_call_id": "tool", "turn_id": "turn", "gateId": "gate", "requestId": "request", "cookie": "secret"})
    sender.enqueue("on_session_start", (), {"session_id": "session-b"})
    sender.process_once()
    first, second = transport.acked
    assert first["sessionKey"] == "sk-structural123456" and first["sessionId"] == "session-a"
    assert second["sessionId"] == "session-b"
    assert first["payload"]["gateId"] == "gate" and first["payload"]["requestId"] == "request"
    assert first["payload"]["turn_id"] == "turn" and first["toolCallId"] == "tool"
    assert "secret" not in json.dumps(first)


def test_in_a_gateway_the_sender_says_hello_once_without_waiting_for_a_hook(setup, monkeypatch):
    # The hello starts the command poller, so a rewind works right after a plugin (re)load (PLAN 5.33 live check).
    import sys
    import types
    sender, transport = setup
    monkeypatch.setitem(sys.modules, "gateway.run", types.ModuleType("gateway.run"))
    monkeypatch.setattr(sender.client, "_allow_decisions", False)  # no pollers in this test
    for _ in range(3):
        sender._greet()
        sender._next_greeting = 0.0
    hellos = [call for call in transport.calls if call[0].endswith("/hello")]
    assert len(hellos) == 1 and sender._greeted


def test_outside_a_gateway_the_sender_waits_for_a_hook_before_hello(setup, monkeypatch):
    import sys
    sender, transport = setup
    monkeypatch.delitem(sys.modules, "gateway.run", raising=False)
    sender._greet()
    assert not [call for call in transport.calls if call[0].endswith("/hello")]
