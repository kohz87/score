"""Private-pipe integration with real Score routes and an in-memory Hermes queue."""
import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from score_bridge import hermes_private
from score_bridge.client import ScoreClient
from score_bridge.decisions import DecisionPoller
from score_bridge.sender import Sender
from score_bridge.spool import Spool

import threading
from types import SimpleNamespace

queue = [
    SimpleNamespace(data={"request_id": "unrelated", "command": "rm other/dist", "pattern_keys": ["rm"]}),
    SimpleNamespace(data={"request_id": "exact-target", "command": "rm demo/dist", "pattern_keys": ["rm"]}),
]
lock = threading.Lock()
resolved = []
class ResolvedEvent:
    def set(self):
        resolved.append("exact-target")
queue[0].result = queue[1].result = None
queue[0].event = threading.Event()
queue[1].event = ResolvedEvent()


attrs = {"tools.approval._lock": lock, "tools.approval._gateway_queues": {"gateway-session": queue}}
hermes_private._lookup_attr = attrs.get
apis = {
    "tools.approval.list_gateway_approvals": lambda session: [],
    "tools.approval.resolve_gateway_approval": lambda *args: None,
    "hermes_cli.plugin_isolation.isolation_mode": lambda: "in_process",
    "hermes_cli.profiles.current_profile_name": lambda: "builder",
}
hermes_private._lookup = apis.get
hermes_private.version_info = lambda: {"version": "0.21.0", "codeSha": "fixture"}
DecisionPoller.start = lambda self: None


def transport(url, token, body, timeout):
    print(json.dumps({"url": url, "authorization": f"Bearer {token}", "body": body}), flush=True)
    response = json.loads(sys.stdin.readline())
    assert response["statusCode"] in (200, 204), response
    return response["body"]


home = Path(sys.argv[2])
client = ScoreClient("http://127.0.0.1", home / "bridge.token", transport=transport,
                     profile="builder")
sender = Sender(client, Spool(client.incarnation, home / "spool"))
sender.enqueue("pre_approval_request", (), {"session_key": "gateway-session", "surface": "gateway",
    "command": "rm demo/dist", "pattern_keys": ["rm"], "tool_call_id": "tool-1"})
sender.process_once()
assert client.enabled["gatewayApprovals"]
client._poller.process_once()
assert resolved == ["exact-target"]
assert [entry.data["request_id"] for entry in queue] == ["unrelated"]
sender.shutdown()
print(json.dumps({"resolved": resolved, "pending": [entry.data["request_id"] for entry in queue]}), flush=True)
