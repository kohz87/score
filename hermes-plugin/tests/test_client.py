import json
from datetime import datetime, timezone
from urllib.error import HTTPError

import pytest

from score_bridge import hermes_private
from score_bridge.client import NotReady, ProtocolError, ScoreClient, urllib_transport
from helpers import FakeTransport


@pytest.fixture
def token(tmp_path):
    path = tmp_path / "bridge.token"
    path.write_text("bootstrap\n")
    return path


def test_hello_contract(token, monkeypatch):
    monkeypatch.setenv("HERMES_PROFILE", "builder")
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_test")
    monkeypatch.setenv("SCORE_URL", "http://127.0.0.1:9999/")
    transport = FakeTransport()
    client = ScoreClient(token_path=token, transport=transport)
    client.hello()
    url, secret, req, timeout = transport.calls[0]
    assert url == "http://127.0.0.1:9999/bridge/v1/hello"
    assert secret == "bootstrap" and timeout == 3
    assert set(req) == {"profile", "pid", "incarnation", "kanbanTaskId", "isolation", "pluginVersion", "hermes", "privateApis"}
    assert req["profile"] == "builder" and req["pid"] > 0
    assert req["incarnation"] == client.incarnation
    assert int(req["incarnation"], 16) > 0
    assert req["kanbanTaskId"] == "t_test" and req["pluginVersion"] == "0.1.0"
    assert req["hermes"] == {"version": "test", "codeSha": "fixture-sha"}
    assert req["privateApis"] == hermes_private.available()
    assert client.producer_token == "producer"


@pytest.mark.parametrize("home,profile", [("/profiles/reviewer", "default"), ("/home/example/.hermes", "default")])
def test_profile_home_fallback(home, profile, token, monkeypatch):
    monkeypatch.delenv("HERMES_PROFILE", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    monkeypatch.setenv("HERMES_HOME", home)
    client = ScoreClient(token_path=token, transport=FakeTransport())
    assert client.identity()["profile"] == profile
    assert client.identity()["kanbanTaskId"] is None


def test_host_isolation_hello(token, monkeypatch):
    monkeypatch.setattr(hermes_private, "isolation_mode", lambda: "host")
    transport = FakeTransport()
    ScoreClient(token_path=token, transport=transport).hello()
    assert transport.calls[0][2]["isolation"] == "host"


def test_unknown_isolation_still_reports_events(token, monkeypatch):
    monkeypatch.setattr(hermes_private, "isolation_mode", lambda: "unknown")
    transport = FakeTransport()
    ScoreClient(token_path=token, transport=transport).hello()
    assert transport.calls[0][2]["isolation"] == "unknown"


def test_missing_bootstrap_is_idle(tmp_path):
    transport = FakeTransport()
    with pytest.raises(NotReady):
        ScoreClient(token_path=tmp_path / "missing", transport=transport).hello()
    assert transport.calls == []


def test_rehello_401_and_near_expiry(token):
    transport = FakeTransport()
    transport.expiry = 10_000
    now = [9000]
    client = ScoreClient(token_path=token, transport=transport, clock=lambda: now[0])
    client.send([{"counter": 1}])
    now[0] = 9941
    transport.expiry = 11_000
    client.send([{"counter": 2}])
    transport.unauthorized = True
    client.send([{"counter": 3}])
    assert [call[0].rsplit("/", 1)[-1] for call in transport.calls] == [
        "hello", "events", "hello", "events", "events", "hello", "events"]
    assert all(call[1] == "producer" for call in transport.calls if call[0].endswith("events"))


@pytest.mark.parametrize("response", [None, {}, {"producerToken": "p", "expiresAt": "bad", "enabled": {}},
    {"producerToken": "p", "expiresAt": "2030-01-01T00:00:00", "enabled": {}},
    {"producerToken": "p", "expiresAt": "2020-01-01T00:00:00Z", "enabled": {}}])
def test_reject_invalid_hello(token, response):
    client = ScoreClient(token_path=token, transport=lambda *args: response)
    with pytest.raises(ProtocolError):
        client.hello()
    assert client.producer_token is None


@pytest.mark.parametrize("ack", [None, -1, True, "1", 1.5])
def test_reject_invalid_ack(token, ack):
    client = ScoreClient(token_path=token, transport=lambda *args: {"ackedThrough": ack})
    client.producer_token = "producer"
    client.expires_at = 2_000_000_000
    with pytest.raises(ProtocolError):
        client.send([{"counter": 1}])


def test_http_5xx_propagates_to_sender(token):
    client = ScoreClient(token_path=token, transport=FakeTransport())
    client.hello()
    def broken(*args):
        raise HTTPError(args[0], 503, "unavailable", {}, None)
    client.transport = broken
    with pytest.raises(HTTPError):
        client.send([{"counter": 1}])


def test_urllib_request_and_timeout(monkeypatch):
    from score_bridge import client as module
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self, size):
            assert size == 1_048_577
            return b'{"ackedThrough": 1}'
    class Opener:
        def open(self, request, timeout):
            assert request.full_url == "http://127.0.0.1/bridge/v1/events"
            assert request.get_header("Authorization") == "Bearer producer"
            assert request.method == "POST"
            assert json.loads(request.data) == {"events": []}
            assert timeout == 3.0
            return Response()
    monkeypatch.setattr(module, "build_opener", lambda handler: Opener())
    assert urllib_transport("http://127.0.0.1/bridge/v1/events", "producer", {"events": []}, 3.0) == {"ackedThrough": 1}
