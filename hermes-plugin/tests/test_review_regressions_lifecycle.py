"""Regression probes for fork, shutdown, cancellation and re-registration findings."""

import atexit
import json
import os
import select
import signal
import threading
import time
from pathlib import Path

import pytest

import score_bridge
from score_bridge.client import ScoreClient
from score_bridge.redact import scrub
from score_bridge.spool import Spool
from helpers import FakeTransport, make_hook


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


def test_s2_025_reregistered_plugin_adopts_the_outbox_of_the_sender_it_retired(tmp_path, monkeypatch):
    """A reload inside a live gateway keeps the pid and start time: the retired sender's unsent history must still drain."""
    monkeypatch.setenv("SCORE_HOME", str(tmp_path / "home"))
    token = tmp_path / "token"
    token.write_text("bootstrap")
    transport = FakeTransport()
    transport.down = True
    monkeypatch.setattr(atexit, "register", lambda callback: None)
    monkeypatch.setattr(atexit, "unregister", lambda callback: None)
    monkeypatch.setattr(score_bridge, "_sender", None)
    monkeypatch.setattr(score_bridge, "_exit_callback", None)
    import score_bridge.client as client_module
    class Bound(ScoreClient):
        def __init__(self, base_url=None, token_path=token, transport_=None, **kwargs):
            super().__init__(base_url, token_path, transport_ or transport, **kwargs)
    monkeypatch.setattr(client_module, "ScoreClient", Bound)
    class Context:
        def __init__(self):
            self.hooks = {}
        def register_hook(self, name, wrapper):
            self.hooks[name] = wrapper
    first = Context()
    score_bridge.register(first)
    old = score_bridge._sender
    first.hooks["pre_tool_call"](command="echo offline history")
    old.process_once()  # persisted to the outbox, not deliverable
    assert old.spool.path.exists() and transport.acked == []
    second = Context()
    score_bridge.register(second)  # same process: the first sender is shut down and retired
    current = score_bridge._sender
    assert current is not old and old._closed
    transport.down = False
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not transport.acked:
        current.process_once()
        time.sleep(0.05)
    try:
        assert [e["payload"].get("command") for e in transport.acked] == ["echo offline history"]
        assert not old.spool.path.exists()
    finally:
        current.shutdown(0.5)
