"""Authenticated bridge transport. Called only by the sender, never by hooks."""
from __future__ import annotations

import json
import os
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from . import hermes_private

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
        self.clock = clock
        self.incarnation = uuid.uuid4().hex
        self.producer_token: str | None = None
        self.expires_at = 0.0
        self.enabled: dict[str, bool] = {}
        self.timeout = 3.0
        self._identity: dict | None = None
        self.profile = profile

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
        return recovered

    def hello(self) -> dict:
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
        return response

    def send(self, events: list[dict]) -> int:
        if self.producer_token is None or self.expires_at <= self.clock() + 60:
            self.hello()
        try:
            response = self.transport(self.base_url + "/bridge/v1/events", self.producer_token,
                                      {"events": events}, self.timeout)
        except HTTPError as exc:
            if exc.code != 401:
                raise
            self.producer_token = None
            self.hello()
            response = self.transport(self.base_url + "/bridge/v1/events", self.producer_token,
                                      {"events": events}, self.timeout)
        ack = response.get("ackedThrough") if isinstance(response, dict) else None
        if type(ack) is not int or ack < 0:
            raise ProtocolError("invalid acknowledgement")
        return ack
