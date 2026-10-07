"""Exercise the boundary with fake import results, never with a Hermes import."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def private(monkeypatch):
    path = Path(__file__).parents[1] / "score_bridge/hermes_private.py"
    spec = importlib.util.spec_from_file_location("score_bridge._boundary_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    def missing(name):
        raise ImportError(name)
    monkeypatch.setattr(module.importlib, "import_module", missing)
    return module


def test_availability_partial_and_force_redaction(private, monkeypatch):
    calls = []
    def forced(text, *, force):
        calls.append((text, force))
        return text.replace("hermes-only-secret", "[redacted]")
    def fake_import(name):
        if name == "agent.redact":
            return SimpleNamespace(redact_sensitive_text=forced)
        if name == "tools.approval":
            return SimpleNamespace(list_gateway_approvals=lambda: [])
        raise ImportError(name)
    monkeypatch.setattr(private.importlib, "import_module", fake_import)
    availability = private.available()
    assert availability["agent.redact.redact_sensitive_text"] is True
    assert availability["tools.approval.list_gateway_approvals"] is True
    assert availability["tools.approval.resolve_gateway_approval"] is False
    assert private.redact("hermes-only-secret password=opaque") == "[redacted] password=[redacted]"
    assert calls == [("hermes-only-secret password=opaque", True)]
    availability.clear()
    assert private.available()


def test_missing_private_apis_fallback(private):
    assert not any(private.available().values())
    assert private.redact("echo token=secret") == "echo token=[redacted]"
    assert private.isolation_mode() == "unknown"
    assert private.version_info() == {"version": "unknown", "codeSha": "unknown"}


def test_throwing_redactor_fallback(private, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError()
    monkeypatch.setattr(private.importlib, "import_module", lambda name: SimpleNamespace(redact_sensitive_text=broken))
    assert "raw" not in private.redact("api_key=raw")


def test_host_marker_overrides_upstream_in_process(private, monkeypatch):
    monkeypatch.setattr(private.importlib, "import_module", lambda name: SimpleNamespace(isolation_mode=lambda: "in_process"))
    monkeypatch.setenv("HERMES_PLUGIN_HOST_PROCESS", "1")
    assert private.isolation_mode() == "host"


@pytest.mark.parametrize("mode", ["host", "in_process", "invalid"])
def test_isolation_helper_modes(private, monkeypatch, mode):
    monkeypatch.delenv("HERMES_PLUGIN_HOST_PROCESS", raising=False)
    monkeypatch.setattr(private.importlib, "import_module", lambda name: SimpleNamespace(isolation_mode=lambda: mode))
    assert private.isolation_mode() == (mode if mode != "invalid" else "unknown")


def test_version_metadata(private, monkeypatch):
    info = SimpleNamespace(display_version="0.21.0", commit="abc123")
    monkeypatch.setattr(private.importlib, "import_module", lambda name: SimpleNamespace(get_version_info=lambda: info))
    assert private.version_info() == {"version": "0.21.0", "codeSha": "abc123"}


def test_hermes_imports_are_confined_to_private_boundary():
    import ast
    package = Path(__file__).parents[1] / "score_bridge"
    for path in package.glob("*.py"):
        if path.name == "hermes_private.py":
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            assert not any(name.split(".")[0] in {"agent", "tools", "hermes_cli", "hermes_constants"}
                           for name in names), path


def test_current_profile_uses_context_helper_before_environment(private, monkeypatch):
    calls = []
    def import_profile(name):
        assert name == "hermes_cli.profiles"
        calls.append(name)
        return SimpleNamespace(current_profile_name=lambda: "reviewer")
    monkeypatch.setenv("HERMES_PROFILE", "builder")
    monkeypatch.setattr(private.importlib, "import_module", import_profile)
    assert private.current_profile() == "reviewer"
    assert calls == ["hermes_cli.profiles"]


def test_current_profile_falls_back_when_helper_missing_or_throwing(private, monkeypatch):
    monkeypatch.setenv("HERMES_PROFILE", "builder")
    assert private.current_profile() == "builder"
    private._lookup.cache_clear()
    monkeypatch.setattr(private.importlib, "import_module", lambda name: SimpleNamespace(
        current_profile_name=lambda: (_ for _ in ()).throw(ValueError())))
    assert private.current_profile() == "builder"
    monkeypatch.delenv("HERMES_PROFILE")
    assert private.current_profile() == "default"


@pytest.mark.parametrize("cancel", [KeyboardInterrupt, SystemExit, GeneratorExit])
def test_boundary_propagates_cancellation(private, monkeypatch, cancel):
    monkeypatch.setattr(private.importlib, "import_module", lambda name: SimpleNamespace(
        redact_sensitive_text=lambda *args, **kwargs: (_ for _ in ()).throw(cancel())))
    with pytest.raises(cancel):
        private.redact("text")


@pytest.mark.parametrize("request_id", [None, "", 0, False, [], {}, "exact-1"])
def test_resolution_never_uses_fifo(private, monkeypatch, request_id):
    calls = []
    def resolve(session, choice, **kwargs):
        assert set(kwargs) == {"request_id"}
        assert type(kwargs["request_id"]) is str and kwargs["request_id"]
        calls.append((session, choice, kwargs))
        return 1
    monkeypatch.setattr(private.importlib, "import_module", lambda name: SimpleNamespace(
        resolve_gateway_approval=resolve))
    assert private.resolve_exact("s", "once", request_id) == (1 if request_id == "exact-1" else 0)
    assert len(calls) == (1 if request_id == "exact-1" else 0)


def test_no_settle_slot_reference_in_plugin():
    package = Path(__file__).parents[1] / "score_bridge"
    forbidden = "register_gateway_" + "settle"
    assert all(forbidden not in path.read_text() for path in package.glob("*.py"))


def _approval_module(lock, queues):
    return SimpleNamespace(_lock=lock, _gateway_queues=queues)


def test_snapshot_is_bounded_and_never_waits_on_a_held_lock(private, monkeypatch):
    import threading
    import time
    lock = threading.Lock()
    entry = SimpleNamespace(data={"request_id": "r1", "command": "rm x", "pattern_keys": ["rm"]})
    queues = {"s": [entry], "big": [entry] * 65}
    monkeypatch.setattr(private.importlib, "import_module", lambda name: _approval_module(lock, queues))
    assert private.snapshot_gateway_approvals("s") == [entry.data]
    assert private.snapshot_gateway_approvals("missing") == []
    assert private.snapshot_gateway_approvals("big") is None
    lock.acquire()
    try:
        started = time.perf_counter()
        assert private.snapshot_gateway_approvals("s") is None
        assert private.approval_lock_free(0.01) is False
        assert time.perf_counter() - started < 0.2
    finally:
        lock.release()
    assert private.approval_lock_free(0.01) is True


def test_snapshot_without_hermes_internals_is_none(private):
    assert private.snapshot_gateway_approvals("s") is None
    assert private.approval_lock_free(0.01) is False


@pytest.mark.parametrize("result, expected", [
    ((True, "delete", "description"), "delete"), ((False, "delete", "description"), None),
    ((True, None, "description"), None), ((True, "", "description"), None),
    ((True, "x" * 257, "description"), None), (None, None),
])
def test_danger_detection_boundary(private, monkeypatch, result, expected):
    calls = []
    def detector(command):
        calls.append(command)
        return result
    monkeypatch.setattr(private.importlib, "import_module", lambda name: SimpleNamespace(detect_dangerous_command=detector))
    assert private.detect_dangerous("rm -rf /tmp/example") == expected
    assert calls == ["rm -rf /tmp/example"]
    assert private.detect_dangerous("x" * 16385) is None
    assert len(calls) == 1


def test_danger_detection_missing_or_throwing(private, monkeypatch):
    assert private.detect_dangerous("rm x") is None
    private._lookup.cache_clear()
    def broken(command):
        raise ValueError()
    monkeypatch.setattr(private.importlib, "import_module", lambda name: SimpleNamespace(detect_dangerous_command=broken))
    assert private.detect_dangerous("rm x") is None
