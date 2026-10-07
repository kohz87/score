"""Regression probes for accepted adversarial findings 1–14."""
import atexit
import contextvars
import hashlib
import json
import os
import select
import signal
import threading
import time
from pathlib import Path
from urllib.error import HTTPError

import pytest

import score_bridge
from score_bridge import hermes_private
from score_bridge.client import ScoreClient
from score_bridge.redact import PAYLOAD_CAP, local_redact, scrub, snapshot
from score_bridge.sender import Sender, merge_ranges
from score_bridge.spool import Spool, _valid_event, encode
from helpers import FakeTransport, make_hook
from test_spool import event


@pytest.fixture
def setup(tmp_path):
    token = tmp_path / "token"
    token.write_text("bootstrap")
    transport = FakeTransport()
    client = ScoreClient(token_path=token, transport=transport)
    sender = Sender(client, Spool(client.incarnation, tmp_path / "spool"))
    yield sender, transport
    sender.shutdown(0.1)


def test_01_eviction_does_not_release_foreign_objects(setup):
    sender, _ = setup
    sender.queue.maxsize = 1
    destroyed = []
    class Slow:
        def __del__(self):
            destroyed.append(True)
            time.sleep(0.1)
    hook = make_hook("pre_tool_call", sender)
    hook(result=Slow())
    assert destroyed == [True]  # Ownership ends at capture, never in the outbox.
    started = time.perf_counter()
    hook(result="replacement")
    assert time.perf_counter() - started < 0.001
    assert sender.dropped == 1


def test_01_admission_contention_has_two_ms_budget_and_reports_loss(setup):
    sender, transport = setup
    hook = make_hook("pre_tool_call", sender)
    sender.queue.mutex.acquire()
    try:
        started = time.monotonic()
        hook(command="echo hello")
        assert time.monotonic() - started < 0.02
        assert sender.contended == 1
    finally:
        sender.queue.mutex.release()
    hook(command="echo next")
    sender.process_once()
    assert transport.acked[0]["hook"] == "bridge.gap"
    assert transport.acked[0]["payload"]["dropped"] == 1
    assert transport.acked[1]["hook"] == "pre_tool_call"


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


@pytest.mark.filterwarnings("ignore:This process .* is multi-threaded:DeprecationWarning")
@pytest.mark.skipif(not hasattr(os, "fork"), reason="requires POSIX fork")
def test_03_real_fork_resets_held_locks_and_existing_wrapper(setup, monkeypatch):
    from score_bridge import spool as spool_module
    sender, _ = setup
    monkeypatch.setattr(score_bridge, "_sender", sender)
    monkeypatch.setattr(score_bridge, "_exit_callback", None)
    wrapper = score_bridge._make_hook("pre_tool_call")
    # A running network sender and inherited Python/file locks reproduce the review probe.
    sender.start()
    read_fd, write_fd = os.pipe()
    lock = sender.spool._locked()
    lock.__enter__()
    inherited_fds = tuple(spool_module._OPEN_FDS)
    sender.queue.mutex.acquire()
    sender._start_lock.acquire()
    sender._persist_lock.acquire()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(read_fd)
            child = score_bridge._sender
            assert child is not sender and child._thread is None
            assert child.client.incarnation != sender.client.incarnation
            assert child.queue.mutex.acquire(False)
            child.queue.mutex.release()
            for fd in inherited_fds:
                with pytest.raises(OSError):
                    os.fstat(fd)
            wrapper(command="echo child")
            assert child._thread.is_alive()
            assert child.queue.qsize() == 1
            os.write(write_fd, b"ok")
        except Exception as exc:
            os.write(write_fd, type(exc).__name__.encode())
        finally:
            os._exit(0)
    os.close(write_fd)
    try:
        assert select.select([read_fd], [], [], 2)[0], "child hook deadlocked"
        assert os.read(read_fd, 128) == b"ok"
    finally:
        sender._persist_lock.release()
        sender._start_lock.release()
        sender.queue.mutex.release()
        lock.__exit__(None, None, None)
        os.close(read_fd)
        os.kill(pid, signal.SIGKILL) if os.waitpid(pid, os.WNOHANG)[0] == 0 else None
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


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
             "Cookie", "credential", "sessionId", "prefix_client-secret_suffix"]
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


@pytest.mark.parametrize("which", ["queue", "persist", "file"])
def test_07_shutdown_budget_includes_held_locks(setup, which):
    sender, transport = setup
    sender.enqueue("post_tool_call", (), {"result": "text"})
    lock = sender.queue.mutex if which == "queue" else sender._persist_lock
    external = sender.spool._locked() if which == "file" else None
    if external:
        external.__enter__()
    else:
        lock.acquire()
    started = time.monotonic()
    try:
        sender.shutdown(0.01)
        assert time.monotonic() - started < 0.05
        assert sender.dropped == 1
        assert transport.calls == []
    finally:
        external.__exit__(None, None, None) if external else lock.release()


def test_07_exit_flushes_synchronously_without_new_threads_or_network(setup, monkeypatch):
    sender, transport = setup
    for _ in range(4):
        sender.enqueue("post_tool_call", (), {"result": "password=opaque"})
    monkeypatch.setattr(threading.Thread, "start", lambda self: (_ for _ in ()).throw(AssertionError("thread created at exit")))
    sender.shutdown()
    assert transport.calls == []
    saved = sender.spool.path.read_text()
    assert "opaque" not in saved
    assert len(sender.spool.peek()) == 4


@pytest.mark.parametrize("cancel", [KeyboardInterrupt, SystemExit, GeneratorExit])
def test_08_wrappers_and_redaction_propagate_host_cancellation(setup, monkeypatch, cancel):
    sender, _ = setup
    def interrupted(*args):
        raise cancel()
    monkeypatch.setattr(sender, "enqueue", interrupted)
    with pytest.raises(cancel):
        make_hook("pre_approval_request", sender)()
    with pytest.raises(cancel):
        scrub({"text": "hello"}, interrupted)
    assert not sender.errors


@pytest.mark.parametrize("cancel", [KeyboardInterrupt, SystemExit])
def test_08_sender_cancellation_stops_loop(setup, monkeypatch, cancel):
    sender, _ = setup
    monkeypatch.setattr(sender, "process_once", lambda: (_ for _ in ()).throw(cancel()))
    sender._wake.set()
    sender._run()
    assert sender._stop.is_set()


def test_09_corrupt_binary_records_count_and_persist_loss(tmp_path):
    spool = Spool("producer", tmp_path, file_cap=2048, directory_cap=4096)
    spool.path.write_bytes(b"\xff\nnot-json\n" + encode([event(1)]))
    assert spool.peek() == [event(1)]
    assert spool.corrupt == spool.dropped == 2
    restored = Spool("producer", tmp_path)
    marker = restored.pending_gap()
    assert marker["payload"]["corrupt_records"] == 2
    assert spool.path.stat().st_size <= 2048
    assert b"not-json" not in spool.path.read_bytes()
    assert restored.peek() == [event(1)]


def test_09_caps_use_physical_bytes_and_reads_are_bounded(tmp_path, monkeypatch):
    spool = Spool("producer", tmp_path, file_cap=2048, directory_cap=4096)
    (tmp_path / "oversize.jsonl").write_bytes(b"\xff\n" * 5000)
    (tmp_path / "whitespace.jsonl").write_bytes(b" " * 5000 + encode([event(1)]))
    import score_bridge.spool as module
    original = module.os.fdopen
    reads = []
    class BinaryReader:
        def __init__(self, stream):
            self.stream = stream
        def __enter__(self):
            self.stream.__enter__()
            return self
        def __exit__(self, *args):
            return self.stream.__exit__(*args)
        def fileno(self):
            return self.stream.fileno()
        def read(self, size):
            reads.append(size)
            assert size <= spool.file_cap
            return self.stream.read(size)
    monkeypatch.setattr(module.os, "fdopen", lambda fd, mode, **kw: BinaryReader(original(fd, mode, **kw))
                        if mode == "rb" else original(fd, mode, **kw))
    spool.append([event(1)])
    assert reads
    assert sum(p.stat().st_size for p in tmp_path.glob("*.jsonl")) <= spool.directory_cap
    assert all(p.stat().st_size <= spool.file_cap for p in tmp_path.glob("*.jsonl"))
    assert spool.corrupt > 0
    assert Spool("oversize", tmp_path, file_cap=2048, directory_cap=4096).pending_gap()["payload"]["corrupt_records"] > 0


def test_10_hook_cannot_forge_spool_flags(setup):
    sender, transport = setup
    payload = {"_pending_gap": True, "_internal": "raw", "args": {"command": "echo hello", "_control": True}}
    sender.enqueue("pre_tool_call", (), payload)
    sender.process_once()
    assert len(transport.acked) == 1
    assert transport.acked[0]["payload"]["args"] == {"command": "echo hello"}
    assert "_pending_gap" not in json.dumps(transport.acked)
    assert not sender.spool.path.exists()


def test_10_spool_never_interprets_hook_payload_as_envelope(tmp_path):
    spool = Spool("producer", tmp_path)
    ordinary = event(1)
    ordinary["payload"] = {"_pending_gap": True, "args": {"command": "echo hello"}}
    spool.append([ordinary])
    assert spool.peek() == [ordinary] and spool.pending_gap() is None
    malformed = event(2)
    malformed["hook"] = "bridge.gap"
    assert not _valid_event(malformed)


@pytest.mark.parametrize("status", [401, 403, 404, 503])
def test_11_rejected_orphan_does_not_block_current_producer(setup, status):
    sender, transport = setup
    old_client = ScoreClient(token_path=sender.client.token_path, transport=transport)
    identity = old_client.identity()
    identity["pid"] = 999_999_999
    old = Spool(old_client.incarnation, sender.spool.directory)
    old.producer = identity
    old.append([event(1)])
    old_calls = []
    def reject_old(url, token, body, timeout):
        if url.endswith("hello") and body["incarnation"] == old_client.incarnation:
            old_calls.append(body)
            raise HTTPError(url, status, "rejected", {}, None)
        return transport(url, token, body, timeout)
    sender.client.transport = reject_old
    sender.enqueue("pre_tool_call", (), {"command": "echo current"})
    sender.process_once()
    assert transport.acked[0]["payload"]["command"] == "echo current"
    sender.process_once()
    assert len(old_calls) == 1  # Per-orphan backoff or quarantine.
    if status != 503:
        assert not old.path.exists()
        assert (old.directory / "quarantine" / old.path.name).exists()
        assert sender.quarantined == 1
    else:
        assert old.path.exists() and sender.quarantined == 0


def test_12_queue_gap_is_first_batch_under_sustained_traffic(setup):
    sender, transport = setup
    sender.queue.maxsize = 2
    for i in range(10):
        sender.enqueue("pre_tool_call", (), {"command": str(i)})
    sender.process_once()
    assert transport.event_calls[0][0]["hook"] == "bridge.gap"
    assert transport.event_calls[0][0]["payload"]["dropped"] == 8
    assert len(transport.event_calls[0]) == 3
    assert [e["counter"] for e in transport.acked] == [9, 10, 11]


def test_12_range_metadata_is_merged_and_bounded():
    ranges = []
    for i in range(1000):
        merge_ranges(ranges, i * 3 + 1, i * 3 + 1, "at")
    assert len(ranges) <= 100
    assert ranges[0][0] == 1 and ranges[-1][1] == 2998
    merge_ranges(ranges, 1, 2999, "at")
    assert ranges == [(1, 2999, "at")]


def test_12_spool_gap_precedes_new_events_with_busy_queue(setup):
    sender, transport = setup
    sender.spool.file_cap = 3000
    sender.spool.directory_cap = 6000
    transport.down = True
    for _ in range(5):
        sender.enqueue("post_tool_call", (), {"result": "x" * 700})
        sender.process_once()
    transport.down = False
    sender.enqueue("pre_tool_call", (), {"command": "fresh"})
    sender.process_once()
    hooks = [e["hook"] for e in transport.acked]
    assert "bridge.gap" in hooks
    fresh = next(i for i, e in enumerate(transport.acked) if e["payload"].get("command") == "fresh")
    assert hooks.index("bridge.gap") < fresh
    assert [e["counter"] for e in transport.acked] == sorted({e["counter"] for e in transport.acked})


def test_13_reregister_and_unload_stop_sender_and_remove_exact_exit_callback(setup, monkeypatch):
    sender, transport = setup
    registered, unregistered = [], []
    monkeypatch.setattr(atexit, "register", registered.append)
    monkeypatch.setattr(atexit, "unregister", unregistered.append)
    monkeypatch.setattr(score_bridge, "_sender", None)
    monkeypatch.setattr(score_bridge, "_exit_callback", None)
    import score_bridge.client as client_module
    def new_client():
        return ScoreClient(token_path=sender.client.token_path, transport=transport)
    monkeypatch.setattr(client_module, "ScoreClient", new_client)
    class Context:
        def __init__(self):
            self.hooks, self.unload = {}, None
        def register_hook(self, name, wrapper):
            self.hooks[name] = wrapper
        def on_unload(self, callback):
            self.unload = callback
    first = Context()
    score_bridge.register(first)
    old = score_bridge._sender
    old.spool = Spool(old.client.incarnation, sender.spool.directory)
    old._producers[old.client.profile] = (old.client, old.spool)
    first.hooks["pre_tool_call"](command="echo old")
    old._wake.set()
    second = Context()
    score_bridge.register(second)
    current = score_bridge._sender
    current.spool = Spool(current.client.incarnation, sender.spool.directory)
    current._producers[current.client.profile] = (current.client, current.spool)
    assert old._closed and not old._thread.is_alive()
    assert registered[0] in unregistered
    # Even a previously registered wrapper resolves the replacement at call time.
    first.hooks["pre_tool_call"](command="echo new")
    second.unload()
    assert current._closed and not current._thread.is_alive()
    assert registered[-1] in unregistered
    assert score_bridge._sender is None
    score_bridge._reset_after_fork()
    assert score_bridge._sender is None  # An unloaded module cannot resurrect in a child.
    assert current.spool.path.exists()


@pytest.mark.parametrize("component", ["parent", "spool"])
@pytest.mark.parametrize("mode", [0o720, 0o702])
def test_14_unsafe_directory_permissions_refuse_spooling(tmp_path, component, mode):
    parent = tmp_path / "score"
    parent.mkdir(mode=0o700)
    directory = parent / "spool"
    directory.mkdir(mode=0o700)
    (parent if component == "parent" else directory).chmod(mode)
    spool = Spool("producer", directory)
    with pytest.raises(OSError):
        spool.append([event(1)])
    assert spool.refused == 1 and not spool.path.exists()


def test_14_foreign_owner_refused_and_plugin_stays_fail_open(setup, monkeypatch):
    sender, transport = setup
    monkeypatch.setattr(os, "getuid", lambda: os.geteuid() + 1)
    sender.enqueue("post_tool_call", (), {"result": "text"})
    sender.process_once()
    assert sender.dropped == 1
    assert sender.spool.refused > 0 and transport.calls == []
    assert not sender.spool.path.exists()


def test_11_slow_orphan_is_attempted_after_healthy_sends(setup):
    sender, transport = setup
    old_client = ScoreClient(transport=transport)
    old = Spool(old_client.incarnation, sender.spool.directory)
    identity = old_client.identity()
    identity["pid"] = 999_999_999
    old.producer = identity
    old.append([event(1)])
    def orphan_timeout(url, token, body, timeout):
        if url.endswith("hello") and body["incarnation"] == old_client.incarnation:
            assert transport.acked, "orphan delayed a healthy send"
            raise TimeoutError()
        return transport(url, token, body, timeout)
    sender.client.transport = orphan_timeout
    sender.enqueue("pre_tool_call", (), {"command": "echo healthy"})
    sender.process_once()
    assert transport.acked[0]["payload"]["command"] == "echo healthy"


def test_11_quarantine_shares_physical_directory_quota(tmp_path):
    old = Spool("old", tmp_path, file_cap=2048, directory_cap=2400)
    old.append([event(1, 650), event(2, 650)])
    old.quarantine()
    new = Spool("new", tmp_path, file_cap=2048, directory_cap=2400)
    new.append([event(1, 650), event(2, 650)])
    assert sum(p.stat().st_size for p in tmp_path.rglob("*.jsonl")) <= 2400
    assert new.peek() == [event(1, 650), event(2, 650)]


def test_01_all_contention_losses_counted_when_metadata_overflows(setup):
    sender, transport = setup
    sender.contended = 30_001
    sender._contention.extend([sender.client.profile] * 10_000)
    sender.process_once()
    assert transport.acked[0]["payload"]["dropped"] == 30_001


def test_07_actual_interpreter_exit_spools_without_creating_threads(tmp_path):
    import subprocess
    import sys
    code = '''
import atexit, sys, threading
from types import ModuleType
private = ModuleType("score_bridge.hermes_private")
private.current_profile = lambda: "default"
private.available = lambda: {}
private.isolation_mode = lambda: "unknown"
private.version_info = lambda: {"version": "test", "codeSha": "test"}
from score_bridge.redact import local_redact
private.redact = local_redact
sys.modules[private.__name__] = private
from score_bridge.client import ScoreClient
from score_bridge.sender import Sender
from score_bridge.spool import Spool
client = ScoreClient(token_path=sys.argv[1] + "/missing")
sender = Sender(client, Spool(client.incarnation, sys.argv[1]))
sender.enqueue("post_tool_call", (), {"result": "password=opaque-exit-secret"})
def forbidden(self):
    raise RuntimeError("threads are forbidden during exit")
threading.Thread.start = forbidden
atexit.register(sender.shutdown)
'''
    result = subprocess.run([sys.executable, "-c", code, str(tmp_path)],
                            cwd=Path(__file__).parents[1], capture_output=True, text=True, timeout=5)
    assert result.returncode == 0 and result.stderr == ""
    saved = list(tmp_path.glob("*.jsonl"))
    assert len(saved) == 1
    assert "opaque-exit-secret" not in saved[0].read_text()
    assert json.loads(saved[0].read_text())["events"][0]["payload"]["result"] == "password=[redacted]"
