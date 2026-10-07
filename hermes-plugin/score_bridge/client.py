"""Authenticated bridge transport. Called only by the sender, never by hooks."""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from . import hermes_private
from .decision_transport import DecisionTransport

PLUGIN_VERSION = "0.1.0"


class NotReady(Exception):
    """Score has not been bootstrapped, or Hermes isolation cannot be established."""


class ProtocolError(Exception):
    """The server did not return a valid bridge response."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward bridge bearer tokens to a redirect destination.
        return None


def urllib_transport(url: str, token: str, body: dict, timeout: float) -> dict:
    request = Request(url, data=json.dumps(body, allow_nan=False).encode("utf-8"),
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                      method="POST")
    with build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
        raw = response.read(1_048_577)
    if len(raw) > 1_048_576:
        raise ProtocolError("oversized response")
    return json.loads(raw)


class ScoreClient:
    def __init__(self, base_url: str | None = None, token_path: str | Path | None = None,
                 transport=None, *, clock=time.time, profile: str | None = None):
        self.base_url = (base_url or os.environ.get("SCORE_URL", "http://127.0.0.1:8740")).rstrip("/")
        self.token_path = Path(token_path) if token_path else Path.home() / ".score" / "bridge.token"
        self.transport = transport or urllib_transport
        self.decision_transport = DecisionTransport() if transport is None or transport is urllib_transport else transport
        self.clock = clock
        self.incarnation = uuid.uuid4().hex
        self.producer_token: str | None = None
        self.expires_at = 0.0
        self.enabled: dict[str, bool] = {}
        self.timeout = 3.0
        self._identity: dict | None = None
        self.profile = profile
        self._hello_lock = threading.RLock()
        self._poller = None
        self._closed = False
        self._allow_decisions = True

    def identity(self) -> dict:
        if self._identity is None:
            self._identity = {
                "profile": self.profile or hermes_private.current_profile(),
                "pid": os.getpid(), "incarnation": self.incarnation,
                "kanbanTaskId": os.environ.get("HERMES_KANBAN_TASK") or None,
                "isolation": hermes_private.isolation_mode(), "pluginVersion": PLUGIN_VERSION,
                "hermes": hermes_private.version_info(), "privateApis": hermes_private.available(),
            }
        return dict(self._identity)

    def recover(self, identity: dict) -> ScoreClient:
        recovered = ScoreClient(self.base_url, self.token_path, self.transport, clock=self.clock)
        recovered.incarnation = identity["incarnation"]
        recovered._identity = dict(identity)
        recovered._allow_decisions = False
        return recovered

    def hello(self) -> dict:
        with self._hello_lock:
            return self._hello()

    def _hello(self) -> dict:
        # An undetectable isolation mode still reports events; the server keeps actions disabled.
        identity = self.identity()
        try:
            bootstrap = self.token_path.read_text(encoding="utf-8").strip()
        except OSError:
            raise NotReady("bootstrap token unavailable") from None
        if not bootstrap:
            raise NotReady("bootstrap token unavailable")
        response = self.transport(self.base_url + "/bridge/v1/hello", bootstrap, identity, self.timeout)
        if not isinstance(response, dict):
            raise ProtocolError("invalid hello")
        token, expires, enabled = (response.get(key) for key in ("producerToken", "expiresAt", "enabled"))
        try:
            expiry = datetime.fromisoformat(expires.replace("Z", "+00:00"))
            if expiry.tzinfo is None:
                raise ValueError()
            expiry_time = expiry.timestamp()
        except (ValueError, TypeError, AttributeError):
            raise ProtocolError("invalid token expiry") from None
        if (not isinstance(token, str) or not token or expiry_time <= self.clock()
                or not isinstance(enabled, dict)
                or any(type(enabled.get(key)) is not bool for key in ("gatewayApprovals", "kanbanGrants", "watch"))):
            raise ProtocolError("invalid hello")
        self.producer_token, self.expires_at, self.enabled = token, expiry_time, dict(enabled)
        if self._allow_decisions and not self._closed and enabled["gatewayApprovals"] and self._poller is None:
            from .decisions import DecisionPoller
            self._poller = DecisionPoller(self)
            self._poller.start()
        return response

    def decision_request(self, path, body, timeout):
        # Shutdown must not wait behind the sender's renewal: take the lock with a bound and re-check closure after.
        if not self._hello_lock.acquire(timeout=1.0):
            return None
        try:
            if self._closed:
                return None
            if self.producer_token is None or self.expires_at <= self.clock() + 60:
                self._hello()
            if self._closed or not self.enabled.get("gatewayApprovals", False):
                return None
            token = self.producer_token
        finally:
            self._hello_lock.release()
        try:
            return self.decision_transport(self.base_url + path, token, body, timeout)
        except HTTPError as exc:
            if exc.code != 401:
                raise
            if not self._hello_lock.acquire(timeout=1.0):
                return None
            try:
                if self._closed:
                    return None
                if self.producer_token == token:
                    self._hello()
                if self._closed or not self.enabled.get("gatewayApprovals", False):
                    return None
                token = self.producer_token
            finally:
                self._hello_lock.release()
            return self.decision_transport(self.base_url + path, token, body, timeout)

    def stop_decisions(self):
        self._closed = True
        if self._poller is not None:
            self._poller.stop()

    def send(self, events: list[dict]) -> int:
        with self._hello_lock:
            if self.producer_token is None or self.expires_at <= self.clock() + 60:
                self._hello()
            token = self.producer_token
        try:
            response = self.transport(self.base_url + "/bridge/v1/events", token,
                                      {"events": events}, self.timeout)
        except HTTPError as exc:
            if exc.code != 401:
                raise
            with self._hello_lock:
                if self.producer_token == token:
                    self._hello()
                token = self.producer_token
            response = self.transport(self.base_url + "/bridge/v1/events", token,
                                      {"events": events}, self.timeout)
        ack = response.get("ackedThrough") if isinstance(response, dict) else None
        if type(ack) is not int or ack < 0:
            raise ProtocolError("invalid acknowledgement")
        return ack
