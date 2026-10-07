from datetime import datetime, timezone
from urllib.error import HTTPError


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.down = False
        self.unauthorized = False
        self.acked = []
        self.expiry = 2_000_000_000
        self.ack_limit = None

    def __call__(self, url, token, body, timeout):
        self.calls.append((url, token, body, timeout))
        if self.down:
            raise ConnectionRefusedError("Score unavailable")
        if url.endswith("/hello"):
            return {"producerToken": "producer", "expiresAt": datetime.fromtimestamp(self.expiry, timezone.utc).isoformat().replace("+00:00", "Z"),
                    "enabled": {"watch": True, "gatewayApprovals": False, "kanbanGrants": False}}
        if self.unauthorized:
            self.unauthorized = False
            raise HTTPError(url, 401, "expired", {}, None)
        events = body["events"]
        ack = events[-1]["counter"] if self.ack_limit is None else self.ack_limit
        self.acked.extend(e for e in events if e["counter"] <= ack)
        return {"ackedThrough": ack}

    @property
    def event_calls(self):
        return [call[2]["events"] for call in self.calls if call[0].endswith("/events")]


def make_hook(hook, sender):
    """Run the production wrapper with an isolated process sender for each test call."""
    import score_bridge
    wrapper = score_bridge._make_hook(hook)
    def call(*args, **kwargs):
        previous = score_bridge._sender
        score_bridge._sender = sender
        try:
            return wrapper(*args, **kwargs)
        finally:
            score_bridge._sender = previous
    return call
