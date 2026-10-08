"""Watch frame capture: forced redaction before truncation, tails, caps, credential tools (ARCHITECTURE D6)."""
import json
from pathlib import Path

import pytest

from score_bridge import hermes_private
from score_bridge.client import ScoreClient
from score_bridge.redact import LEAF_CAP, PAYLOAD_CAP, TAIL_MARGIN, local_redact, redact_tail
from score_bridge.sender import Sender
from score_bridge.spool import Spool
from helpers import FakeTransport, make_hook

FIXTURE = json.loads((Path(__file__).parent / "fixtures/watch-tool-hooks.json").read_text())
SECRETS = ("fixture-bearer-secret", "fixture-cmd-secret", "sk-fixture-output-secret-123456",
           "ghp_fixtureoutputsecret123456", "fixture-code-secret", "fixture-code-output-secret",
           "fixture-env-file-secret", "AKIA1234567890ABCDEF", "fixture-source-secret",
           "fixture-vault-secret", "fixture-vault-result-secret", "fixture-url-secret")


@pytest.fixture
def sender(tmp_path):
    token = tmp_path / "token"
    token.write_text("bootstrap")
    transport = FakeTransport()
    client = ScoreClient(token_path=token, transport=transport)
    sender = Sender(client, Spool(client.incarnation, tmp_path / "spool"))
    sender.transport = transport
    return sender


def run(sender, records):
    for record in records:
        make_hook(record["hook"], sender)(**record["payload"])
    sender.process_once()
    return sender.transport.acked


def by_call(events, call, hook):
    return next(e for e in events if e["toolCallId"] == call and e["hook"] == hook)


def test_fixture_hooks_never_leak_secrets_and_keep_terminal_capture(sender):
    events = run(sender, FIXTURE)
    text = json.dumps(events)
    for secret in SECRETS:
        assert secret not in text
    post = by_call(events, "call-term", "post_tool_call")["payload"]
    assert post["watch"]["exitCode"] == 3 and post["watch"]["cwd"] == "/work/demo"
    assert post["watch"]["output"].startswith("ok\n") and "[redacted]" in post["watch"]["output"]
    assert post["watch"]["tail"] is False
    assert "fixture-bearer-secret" not in post["args"]["command"]
    code = by_call(events, "call-code", "post_tool_call")["payload"]
    assert "done" in code["watch"]["output"] and "exitCode" not in code["watch"]
    assert all(len(json.dumps(e["payload"])) <= PAYLOAD_CAP for e in events)


def test_credential_tools_keep_only_name_and_status(sender):
    events = run(sender, FIXTURE)
    for hook in ("pre_tool_call", "post_tool_call"):
        payload = by_call(events, "call-vault", hook)["payload"]
        assert payload["tool_name"] == "browser_vault_fill"
        assert not {"args", "result", "command", "watch", "positional_args"} & set(payload)
    assert by_call(events, "call-vault", "post_tool_call")["payload"]["status"] == "ok"
    for word in ("example.test", "me@example.test", "filled"):
        assert word not in json.dumps([by_call(events, "call-vault", "pre_tool_call"),
                                       by_call(events, "call-vault", "post_tool_call")])


def test_positional_args_of_credential_tools_are_dropped(sender):
    make_hook("post_tool_call", sender)("password=positional-secret", tool_name="vault_unlock",
                                         args={"p": "x"}, result="y", status="ok")
    sender.process_once()
    assert "positional-secret" not in json.dumps(sender.transport.acked)
    assert "args" not in sender.transport.acked[0]["payload"]


def test_credential_file_content_is_not_sent(sender):
    events = run(sender, FIXTURE)
    payload = by_call(events, "call-env", "post_tool_call")["payload"]
    assert payload["args"] == {"path": "/work/demo/.env"} and "result" not in payload
    ordinary = by_call(events, "call-file", "post_tool_call")["payload"]
    assert "AKIA" not in ordinary["args"]["content"] and "[redacted]" in ordinary["args"]["content"]


def test_patch_naming_a_credential_file_is_not_sent(sender):
    make_hook("post_tool_call", sender)(tool_name="patch", status="ok", tool_call_id="p",
                                         args={"mode": "patch", "patch": "*** Update File: deploy/id_rsa\n+SECRETLINE\n"},
                                         result="{\"success\": true}")
    sender.process_once()
    assert "SECRETLINE" not in json.dumps(sender.transport.acked)


def test_long_output_is_a_redacted_tail_within_caps(sender):
    output = "line\n" * 12_000 + "TOKEN=fixture-tail-secret\n" + "end\n" * 100
    make_hook("post_tool_call", sender)(tool_name="terminal", status="ok", tool_call_id="t",
                                         args={"command": "make"},
                                         result=json.dumps({"output": output, "exit_code": 0}))
    sender.process_once()
    payload = sender.transport.acked[0]["payload"]
    watch = payload["watch"]
    assert watch["tail"] is True and len(watch["output"]) <= LEAF_CAP
    assert watch["output"].endswith("end\n") and "fixture-tail-secret" not in json.dumps(payload)
    assert "TOKEN=[redacted]" in watch["output"]
    assert payload["result"] == "[omitted: %d chars]" % len(json.dumps({"output": output, "exit_code": 0}))
    assert len(json.dumps(payload)) <= PAYLOAD_CAP


def test_secret_straddling_the_raw_cut_never_leaks(sender):
    secret = "sk-" + "Z9" * 30
    keep = LEAF_CAP + TAIL_MARGIN
    for offset in range(0, len(secret) + 1, 7):
        # The raw cut lands `offset` characters into the secret.
        output = "a" * 500 + secret + "b" * (keep - len(secret) + offset - 3)
        make_hook("post_tool_call", sender)(tool_name="terminal", status="ok", tool_call_id=f"c{offset}",
                                             args={"command": "x"}, result=json.dumps({"output": output}))
    sender.process_once()
    for event in sender.transport.acked:
        assert "Z9Z9Z9Z9" not in event["payload"]["watch"]["output"]
        assert "sk-" not in event["payload"]["watch"]["output"]


def test_redaction_runs_on_the_raw_tail_before_the_cap():
    seen = []
    def spy(text):
        seen.append(text)
        return local_redact(text)
    raw = "x" * (LEAF_CAP + TAIL_MARGIN)
    text, cut = redact_tail(raw, len(raw) + 10, spy)
    assert seen == [raw] and cut and len(text) == LEAF_CAP
    assert redact_tail("short", 5, spy) == ("short", False)


@pytest.mark.parametrize("redactor", [lambda text: (_ for _ in ()).throw(ValueError()), lambda text: None])
def test_failed_forced_redaction_still_redacts(redactor):
    text, _ = redact_tail("password=hunter123 more", 23, redactor)
    assert "hunter123" not in text


def test_forced_hermes_redaction_is_used(sender, monkeypatch):
    calls = []
    def forced(text):
        calls.append(text)
        return local_redact(text).replace("HERMES-ONLY", "[hermes]")
    monkeypatch.setattr(hermes_private, "redact", forced)
    make_hook("post_tool_call", sender)(tool_name="terminal", status="ok", args={"command": "x"},
                                         result=json.dumps({"output": "HERMES-ONLY value"}))
    sender.process_once()
    assert sender.transport.acked[0]["payload"]["watch"]["output"] == "[hermes] value"
    assert any("HERMES-ONLY value" == call for call in calls)


def _vision(sender, call, tool, result):
    make_hook("post_tool_call", sender)("", tool_name=tool, args={}, result=result, status="ok", tool_call_id=call)
    sender.process_once()
    return sender.transport.acked[-1]["payload"]


def test_browser_vision_forwards_only_the_screenshot_path(sender):
    path = "/h/cache/screenshots/browser_screenshot_ab12.png"
    payload = _vision(sender, "v1", "browser_vision", json.dumps({"success": True, "analysis": "x", "screenshot_path": path}))
    assert payload["watch"] == {"screenshotPath": path}
    native = {"meta": {"screenshot_path": path}, "image_data_url": "data:image/jpeg;base64," + "A" * 200000}
    payload = _vision(sender, "v2", "browser_vision", json.dumps(native))
    assert payload["watch"] == {"screenshotPath": path}
    assert len(json.dumps(payload)) <= PAYLOAD_CAP


@pytest.mark.parametrize("bad", ["/etc/passwd", "/h/x/browser_screenshot_zz.png", "x" * 5000 + "/browser_screenshot_ab.png",
                                 "/h/browser_screenshot_ab.png\0"])
def test_browser_vision_rejects_odd_screenshot_paths(sender, bad):
    payload = _vision(sender, "v3", "browser_vision", json.dumps({"screenshot_path": bad}))
    assert "watch" not in payload


def test_other_tools_and_vault_never_forward_a_screenshot_path(sender):
    path = "/h/cache/screenshots/browser_screenshot_ab12.png"
    for index, tool in enumerate(("browser_snapshot", "browser_vault_fill", "terminal")):
        payload = _vision(sender, f"o{index}", tool, json.dumps({"screenshot_path": path}))
        assert "screenshotPath" not in json.dumps(payload.get("watch", {}))


def test_a_tail_window_that_cuts_off_a_private_keys_header_keeps_none_of_its_body():
    # Audit 2026-10-08: ~6 KB of PEM, then ~15 KB of ordinary output; the tail window starts inside the key.
    import random
    rng = random.Random(7)
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    body_lines = ["".join(rng.choice(alphabet) for _ in range(64)) for _ in range(95)]
    pem = "-----BEGIN PRIVATE KEY-----\n" + "\n".join(body_lines) + "\n-----END PRIVATE KEY-----\n"
    logs = "".join(f"line {i}: build step ok\n" for i in range(700))
    output = pem + logs
    raw = output[-(LEAF_CAP + TAIL_MARGIN):]
    assert "BEGIN PRIVATE KEY" not in raw  # the window really did cut the header off
    safe, cut = redact_tail(raw, len(output), lambda text: text)
    assert cut
    for line in body_lines:
        assert line[:24] not in safe
    assert "line 699: build step ok" in safe


def test_credential_file_read_result_and_error_are_not_sent(sender):
    make_hook("post_tool_call", sender)(tool_name="read_file", status="error", tool_call_id="r",
                                         args={"path": "/home/u/.netrc"},
                                         result="machine h login me password willow-tree-17",
                                         error_message="cannot parse: password willow-tree-17")
    sender.process_once()
    sent = json.dumps(sender.transport.acked)
    assert "willow-tree-17" not in sent and "/home/u/.netrc" in sent


def test_empty_hook_ids_are_null_in_envelope_and_payload(sender):
    make_hook("pre_tool_call", sender)(tool_name="terminal", tool_call_id="", session_id="", turn_id="",
                                        args={"command": "ls"})
    sender.process_once()
    event = sender.transport.acked[0]
    assert event["toolCallId"] is None and event["sessionId"] is None
    assert event["payload"]["tool_call_id"] is None and event["payload"]["turn_id"] is None


def test_score_home_sets_token_and_spool_directories(monkeypatch, tmp_path):
    monkeypatch.setenv("SCORE_HOME", str(tmp_path / "custom"))
    assert ScoreClient().token_path == tmp_path / "custom" / "bridge.token"
    assert Spool("abc").directory == tmp_path / "custom" / "spool"
