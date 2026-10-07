"""Exercise the existing plugin transport and spool against a loopback Score server."""
import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])

from score_bridge.client import ScoreClient
from score_bridge.sender import Sender
from score_bridge.spool import Spool

home = Path(sys.argv[3])


def inject_transport(url, token, body, timeout):
    # This is a request protocol on private pipes, never application logging.
    print(json.dumps({"url": url, "authorization": f"Bearer {token}", "body": body}), flush=True)
    response = json.loads(sys.stdin.readline())
    assert response["statusCode"] == 200, "bridge request failed"
    return response["body"]


client = ScoreClient(sys.argv[2], home / "bridge.token",
                     transport=inject_transport if len(sys.argv) > 4 else None, profile="builder",
                     clock=lambda: 1791374400)
sender = Sender(client, Spool(client.incarnation, home / "spool"), capacity=2)
client._identity = {
    "profile": "builder", "pid": 123, "incarnation": client.incarnation,
    "kanbanTaskId": "task-1", "isolation": "unknown", "pluginVersion": "0.1.0",
    "hermes": {"version": "fixture", "codeSha": "fixture"}, "privateApis": {},
}
sender.enqueue("on_session_start", (), {"session_id": "session-1"})
sender.enqueue("pre_tool_call", (), {"session_id": "session-1", "tool_call_id": "tool-1",
                                     "tool_name": "terminal", "args": {"command": "pwd"}})
sender.enqueue("post_tool_call", (), {"session_id": "session-1", "tool_call_id": "tool-1",
                                      "tool_name": "terminal", "status": "ok",
                                      "duration_ms": 9, "result": '{"output":"fixture"}'})
sender.process_once()
assert not sender.errors, list(sender.errors)
assert not sender.spool.peek(), "spool did not drain"
assert client.enabled == {"watch": True, "gatewayApprovals": False, "kanbanGrants": False}
assert client.send([]) == 4
print(json.dumps({"ackedThrough": 4, "dropped": sender.dropped}), flush=True)
