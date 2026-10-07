"""One fail-open daemon per reporting producer, resolving only process-owned exact ids."""
from __future__ import annotations

import threading
import time
from datetime import datetime
from urllib.parse import quote

from . import approvals, hermes_private
from .client import ProtocolError


def validate_item(item):
    if type(item) is not dict:
        raise ProtocolError("invalid decision")
    for key in ("deliveryId", "leaseId", "leaseUntil", "sessionKey", "requestId"):
        if type(item.get(key)) is not str or not item[key]:
            raise ProtocolError("invalid decision")
    if item.get("choice") not in ("once", "session", "always", "deny"):
        raise ProtocolError("invalid decision")
    if item.get("reason") is not None and type(item.get("reason")) is not str:
        raise ProtocolError("invalid decision")
    try:
        lease = datetime.fromisoformat(item["leaseUntil"].replace("Z", "+00:00"))
        if lease.tzinfo is None:
            raise ValueError()
        return lease.timestamp()
    except ValueError:
        raise ProtocolError("invalid lease") from None


class DecisionPoller:
    def __init__(self, client):
        self.client = client
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        if self.thread is None and not self.stop_event.is_set():
            self.thread = threading.Thread(target=self._run, name="score-decisions", daemon=True)
            self.thread.start()

    def process_once(self):
        response = self.client.decision_request("/bridge/v1/decisions?wait=25", None, 28.0)
        if response is None:
            return
        if type(response) is not dict or type(response.get("items")) is not list or len(response["items"]) > 20:
            raise ProtocolError("invalid decisions")
        # Validate the entire batch before acting on any item.
        leases = [validate_item(item) for item in response["items"]]
        for item, lease_until in zip(response["items"], leases):
            if self.stop_event.is_set():
                break
            if self.client.clock() >= lease_until:
                continue
            ack = {"leaseId": item["leaseId"], "outcome": "failed", "resolved": 0}
            if not approvals.reported(self.client.profile, item["sessionKey"], item["requestId"]):
                ack["error"] = "not_reported"
            else:
                try:
                    # Hermes's resolver waits on its approval lock without a bound. Only start while the lease has
                    # a safe margin and the lock is free, so a resolution can't land long after the lease.
                    margin = lease_until - self.client.clock() - 2.0
                    if self.stop_event.is_set() or margin <= 0 or not hermes_private.approval_lock_free(min(margin, 1.0)):
                        raise TimeoutError("not_attempted")
                    resolved = hermes_private.resolve_exact(item["sessionKey"], item["choice"], item["requestId"])
                    if type(resolved) is not int or resolved not in (0, 1):
                        ack["error"] = "invalid_resolution"
                    else:
                        ack.update(outcome="applied" if resolved == 1 else "not_pending", resolved=resolved)
                except TimeoutError:
                    ack["error"] = "not_attempted"
                except Exception:
                    ack["error"] = "resolve_failed"
            path = "/bridge/v1/decisions/" + quote(item["deliveryId"], safe="") + "/ack"
            for attempt in range(4):
                if self.stop_event.is_set():
                    break
                try:
                    self.client.decision_request(path, ack, min(1.0, max(0.1, lease_until - self.client.clock())))
                    break
                except Exception:
                    delay = (0.1, 0.5, 1.0, 0)[attempt]
                    if self.client.clock() + delay >= lease_until or self.stop_event.wait(delay):
                        break

    def _run(self):
        errors = 0
        while not self.stop_event.is_set():
            try:
                if not self.client.enabled.get("gatewayApprovals", False):
                    self.stop_event.wait(0.25)
                    continue
                self.process_once()
                errors = 0
            except Exception:
                if self.stop_event.wait((1, 5, 30)[min(errors, 2)]):
                    return
                errors += 1

    def stop(self):
        self.stop_event.set()
        close = getattr(self.client.decision_transport, "close", None)
        if callable(close):
            close()

    def join(self, deadline):
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(max(0, deadline - time.monotonic()))
