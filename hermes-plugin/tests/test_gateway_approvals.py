import threading
import time
from urllib.error import HTTPError

import pytest
import score_bridge
from score_bridge import approvals, hermes_private
from score_bridge.client import ProtocolError, ScoreClient
from score_bridge.decisions import DecisionPoller
from score_bridge.gates import capture, reset
from score_bridge.sender import Sender
from score_bridge.spool import Spool
from helpers import FakeTransport, make_hook

RAW = {"surface": "gateway", "session_key": "session-1", "command": "echo token=secret", "pattern_keys": ["echo"]}


@pytest.fixture(autouse=True)
def clean_claims(monkeypatch):
    reset()
    yield
    reset()


def pending(request_id="request-1", **extra):
    return {"request_id": request_id, "command": RAW["command"], "pattern_keys": RAW["pattern_keys"], **extra}


def exact(monkeypatch, entries=None, raw=None, profile="builder"):
    monkeypatch.setattr(hermes_private, "snapshot_gateway_approvals", lambda session: [pending()] if entries is None else entries)
    return capture("pre_approval_request", RAW if raw is None else raw, "digest", profile=profile)


def test_exact_capture_claim_and_post(monkeypatch):
    first = exact(monkeypatch)
    assert first["requestId"] == "request-1"
    assert approvals.reported("builder", "session-1", "request-1")
    assert not approvals.reported("reviewer", "session-1", "request-1")
    assert not approvals.reported("builder", "other", "request-1")
    assert exact(monkeypatch)["requestId"] is None
    assert capture("post_approval_response", {"surface": "gateway"}, None)["requestId"] is None
    assert capture("post_approval_response", {"surface": "gateway"}, None)["requestId"] == "request-1"


@pytest.mark.parametrize("entries", [[], [pending(), pending("request-2")], [pending(command="other")],
    [pending(pattern_keys=["other"])], [pending("")], [pending(None)], [pending()] * 65])
def test_missing_or_ambiguous_is_view_only(monkeypatch, entries):
    assert exact(monkeypatch, entries)["requestId"] is None


@pytest.mark.parametrize("extra", [{"surface": "smart"}, {"surface": "transport:telegram"},
    {"coalesced": True}, {"command": "x" * 16385}, {"pattern_keys": ["x"] * 65}])
def test_ineligible_capture_never_lists(monkeypatch, extra):
    monkeypatch.setattr(hermes_private, "snapshot_gateway_approvals", lambda session: pytest.fail("unexpected queue lookup"))
    result = capture("pre_approval_request", {**RAW, **extra, "requestId": "spoof", "request_id": "spoof"}, None)
    assert result["requestId"] is None
    assert "request_id" not in result


def test_capture_exception_fast_and_raw_before_redaction(tmp_path, monkeypatch):
    sender = Sender(ScoreClient(token_path=tmp_path / "token", transport=FakeTransport(), profile="builder"),
                    Spool("fixture", tmp_path / "spool"))
    monkeypatch.setattr(hermes_private, "current_profile", lambda: "builder")
    monkeypatch.setattr(hermes_private, "snapshot_gateway_approvals", lambda session: [pending()])
    hook = make_hook("pre_approval_request", sender)
    hook(**RAW)
    built = sender._build(sender._take()[0])
    assert built["payload"]["requestId"] == "request-1"
    assert "secret" not in built["payload"]["command"]
    def broken(session):
        raise RuntimeError("private secret")
    monkeypatch.setattr(hermes_private, "snapshot_gateway_approvals", broken)
    start = time.monotonic()
    assert hook(**RAW) is None
    assert time.monotonic() - start < 0.02
    assert sender._take()[0]["raw"]["requestId"] is None
    sender.shutdown()


def test_claim_bound_and_concurrent_claim(monkeypatch):
    barrier = threading.Barrier(2)
    def listed(session):
        barrier.wait()
        return [pending()]
    monkeypatch.setattr(hermes_private, "snapshot_gateway_approvals", listed)
    results = []
    threads = [threading.Thread(target=lambda: results.append(approvals.capture_exact(RAW, "builder", "gate"))) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results.count("request-1") == 1 and results.count(None) == 1
    reset()
    for index in range(4096):
        request_id = str(index)
        monkeypatch.setattr(hermes_private, "snapshot_gateway_approvals", lambda session, rid=request_id: [pending(rid)])
        assert approvals.capture_exact(RAW, "builder", "gate") == request_id
    # Full: refuse (view-only) instead of evicting a live claim that another gate could then take.
    monkeypatch.setattr(hermes_private, "snapshot_gateway_approvals", lambda session: [pending("4096")])
    assert approvals.capture_exact(RAW, "builder", "gate") is None
    assert approvals.reported("builder", "session-1", "0")
    approvals.release("0")
    assert not approvals.reported("builder", "session-1", "0")
    assert approvals.capture_exact(RAW, "builder", "gate") == "4096"


def test_post_hook_releases_the_claim(monkeypatch):
    first = exact(monkeypatch)
    assert first["requestId"] == "request-1" and approvals.reported("builder", "session-1", "request-1")
    assert capture("post_approval_response", {"surface": "gateway", "choice": "once"}, None)["requestId"] == "request-1"
    assert not approvals.reported("builder", "session-1", "request-1")


def item(**extra):
    return {"deliveryId": "delivery-1", "leaseId": "lease-1", "leaseUntil": "2030-01-01T00:00:00Z",
            "sessionKey": "session-1", "requestId": "request-1", "choice": "once", "reason": None, **extra}


class DecisionsTransport(FakeTransport):
    def __init__(self):
        super().__init__()
        self.items = [item()]
        self.fail_ack = 0
        self.fail_poll = False
        self.gateway = True
        self.acks = []

    def __call__(self, url, token, body, timeout):
        if url.endswith("/hello"):
            result = super().__call__(url, token, body, timeout)
            result["enabled"]["gatewayApprovals"] = self.gateway
            return result
        self.calls.append((url, token, body, timeout))
        assert token == "producer"
        if self.unauthorized:
            self.unauthorized = False
            raise HTTPError(url, 401, "expired", {}, None)
        if body is None:
            if self.fail_poll:
                raise ConnectionError("private secret")
            return {"items": self.items}
        self.acks.append(dict(body))
        if self.fail_ack:
            self.fail_ack -= 1
            raise ConnectionError("private secret")
        return {}


@pytest.fixture
def poller(tmp_path, monkeypatch):
    token = tmp_path / "token"
    token.write_text("bootstrap")
    transport = DecisionsTransport()
    client = ScoreClient(token_path=token, transport=transport, profile="builder", clock=lambda: 1791374400)
    monkeypatch.setattr(DecisionPoller, "start", lambda self: None)
    client.hello()
    exact(monkeypatch)
    yield client._poller, transport
    client.stop_decisions()


@pytest.mark.parametrize("resolved,outcome,error", [(1, "applied", None), (0, "not_pending", None),
    (2, "failed", "invalid_resolution"), (True, "failed", "invalid_resolution"),
    (None, "failed", "resolve_failed")])
def test_poll_outcomes_and_lease(poller, monkeypatch, resolved, outcome, error):
    worker, transport = poller
    calls = []
    def resolve(session, choice, request_id, deadline, cancelled=None):
        calls.append((session, choice, request_id))
        if resolved is None:
            raise RuntimeError("secret exception")
        return resolved
    monkeypatch.setattr(hermes_private, "resolve_exact_bounded", resolve)
    worker.process_once()
    expected = {"leaseId": "lease-1", "outcome": outcome, "resolved": 1 if outcome == "applied" else 0}
    if error:
        expected["error"] = error
    assert transport.acks == [expected]
    assert calls == [("session-1", "once", "request-1")]
    assert transport.calls[-2][0].endswith("/decisions?wait=25")


@pytest.mark.parametrize("change", [{"requestId": "not-reported"}, {"sessionKey": "other"}])
def test_unreported_never_resolved(poller, monkeypatch, change):
    worker, transport = poller
    transport.items = [item(**change)]
    monkeypatch.setattr(hermes_private, "resolve_exact_bounded", lambda *args, **kwargs: pytest.fail("unreported target"))
    worker.process_once()
    assert transport.acks == [{"leaseId": "lease-1", "outcome": "failed", "resolved": 0, "error": "not_reported"}]


def test_other_producer_never_resolves(poller, monkeypatch):
    worker, transport = poller
    worker.client.profile = "reviewer"
    monkeypatch.setattr(hermes_private, "resolve_exact_bounded", lambda *args, **kwargs: pytest.fail("other producer"))
    worker.process_once()
    assert transport.acks[0]["error"] == "not_reported"


@pytest.mark.parametrize("on_ack", [False, True])
def test_401_renews_for_poll_and_ack(poller, on_ack, monkeypatch):
    worker, transport = poller
    transport.unauthorized = not on_ack
    def resolve(*args, **kwargs):
        transport.unauthorized = on_ack
        return 1
    monkeypatch.setattr(hermes_private, "resolve_exact_bounded", resolve)
    worker.process_once()
    assert len([call for call in transport.calls if call[0].endswith("/hello")]) == 2
    assert transport.acks[-1]["outcome"] == "applied"


def test_ack_retry_does_not_resolve_again(poller, monkeypatch):
    worker, transport = poller
    transport.fail_ack = 2
    calls = []
    monkeypatch.setattr(hermes_private, "resolve_exact_bounded", lambda *args, **kwargs: calls.append(args) or 1)
    worker.process_once()
    assert len(calls) == 1
    assert len(transport.acks) == 3
    assert all(ack == transport.acks[0] for ack in transport.acks)


@pytest.mark.parametrize("bad", [item(requestId=""), item(choice="transport_ok"), item(leaseUntil="bad"),
    item(leaseUntil="2030-01-01T00:00:00"), item(requestId=1)])
def test_invalid_batch_never_resolves(poller, monkeypatch, bad):
    worker, transport = poller
    transport.items = [item(), bad]
    monkeypatch.setattr(hermes_private, "resolve_exact_bounded", lambda *args, **kwargs: pytest.fail("invalid batch"))
    with pytest.raises(ProtocolError):
        worker.process_once()
    assert not transport.acks


def test_expired_lease_and_revoked_capability(poller, monkeypatch):
    worker, transport = poller
    transport.items = [item(leaseUntil="2020-01-01T00:00:00Z")]
    monkeypatch.setattr(hermes_private, "resolve_exact_bounded", lambda *args, **kwargs: pytest.fail("expired lease"))
    worker.process_once()
    assert not transport.acks
    transport.unauthorized = True
    transport.gateway = False
    worker.process_once()
    assert not worker.client.enabled["gatewayApprovals"]
    assert not transport.acks


def test_disabled_and_recovered_hello_does_not_start_poller(tmp_path):
    token = tmp_path / "token"
    token.write_text("bootstrap")
    transport = DecisionsTransport()
    transport.gateway = False
    client = ScoreClient(token_path=token, transport=transport, profile="builder")
    client.hello()
    assert client._poller is None
    recovered = client.recover(client.identity())
    transport.gateway = True
    recovered.hello()
    assert recovered._poller is None


def test_error_backoff_and_stop(poller):
    worker, transport = poller
    transport.fail_poll = True
    waits = []
    class Stop:
        def is_set(self):
            return False
        def wait(self, delay):
            waits.append(delay)
            return len(waits) == 4
    worker.stop_event = Stop()
    worker._run()
    assert waits == [1, 5, 30, 30]
    worker.stop_event = threading.Event()


def test_real_thread_shutdown_and_fork_reset(tmp_path, monkeypatch):
    token = tmp_path / "token"
    token.write_text("bootstrap")
    entered, release = threading.Event(), threading.Event()
    class Blocking(DecisionsTransport):
        def __call__(self, url, token, body, timeout):
            if body is None:
                entered.set()
                release.wait(5)
                return {"items": []}
            return super().__call__(url, token, body, timeout)
        def close(self):
            release.set()
    transport = Blocking()
    client = ScoreClient(token_path=token, transport=transport, profile="builder")
    sender = Sender(client, Spool("fixture", tmp_path / "spool"))
    client.hello()
    assert entered.wait(1)
    worker = client._poller
    assert worker.thread.daemon
    exact(monkeypatch)
    monkeypatch.setattr(score_bridge, "_sender", sender)
    score_bridge._reset_after_fork()
    child = score_bridge._sender
    assert child.client._poller is None and child._lazy_start and child._thread is None
    assert child.client.incarnation != client.incarnation
    assert child.client.producer_token is None
    assert not approvals.reported("builder", "session-1", "request-1")
    started = time.monotonic()
    sender.shutdown()
    assert time.monotonic() - started < 2
    assert not worker.thread.is_alive()
    child.shutdown()


def test_after_fork_takes_no_locks_and_closes_only_a_detached_descriptor():
    import os
    import socket
    from score_bridge.decision_transport import DecisionTransport
    left, right = socket.socketpair()
    class HeldResponseConnection:
        sock = left
        def close(self):
            pytest.fail("child cleanup must not close inherited HTTP objects")
    transport = DecisionTransport()
    transport._lock.acquire()  # held by a parent thread that doesn't exist in the child
    transport._connection = HeldResponseConnection()
    transport.after_fork()
    assert transport._connection is None and transport._lock.acquire(timeout=0.01)
    assert left.fileno() == -1
    right.close()


@pytest.mark.parametrize("lease_seconds", [30, 1])
def test_bounded_resolution_not_attempted_is_acknowledged(monkeypatch, lease_seconds):
    from datetime import datetime, timezone
    exact(monkeypatch)
    calls, acks = [], []
    monkeypatch.setattr(hermes_private, "resolve_exact_bounded", lambda *args, **kwargs: calls.append(args) or None)
    now = time.time()
    lease = datetime.fromtimestamp(now + lease_seconds, timezone.utc).isoformat().replace("+00:00", "Z")
    item = {"deliveryId": "d1", "leaseId": "lease-1", "leaseUntil": lease, "sessionKey": "session-1",
            "requestId": "request-1", "choice": "once", "reason": None}
    class Client:
        profile = "builder"
        enabled = {"gatewayApprovals": True}
        @staticmethod
        def clock():
            return now
        @staticmethod
        def decision_request(path, body, timeout):
            if body is None:
                return {"items": [item]}
            acks.append(body)
            return {}
    DecisionPoller(Client()).process_once()
    assert len(calls) == 1
    assert acks == [{"leaseId": "lease-1", "outcome": "failed", "resolved": 0, "error": "not_attempted"}]
