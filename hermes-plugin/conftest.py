"""Never load Hermes in tests, including during plugin package import."""
import sys
from pathlib import Path
from types import ModuleType

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent / "tests"))
private = ModuleType("score_bridge.hermes_private")
private.available = lambda: {
    name: True for name in (
        "agent.redact.redact_sensitive_text", "tools.approval.list_gateway_approvals",
        "tools.approval.resolve_gateway_approval",
        "tools.approval.approve_permanent", "tools.approval_detection.detect_dangerous_command",
        "hermes_cli.plugin_isolation.isolation_mode",
    )
}
private.isolation_mode = lambda: "in_process"
private.version_info = lambda: {"version": "test", "codeSha": "fixture-sha"}

def redact(text):
    from score_bridge.redact import local_redact
    return local_redact(text)

private.redact = redact
sys.modules[private.__name__] = private

private.current_profile = lambda: __import__("os").environ.get("HERMES_PROFILE") or "default"

private.snapshot_gateway_approvals = lambda session_key, limit=64, timeout=0.005: []
private.approval_lock_free = lambda timeout: True
private.resolve_exact = lambda session_key, choice, request_id: 0
