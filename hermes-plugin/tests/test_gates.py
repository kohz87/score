import threading
from score_bridge.gates import capture, reset


def pre(surface="gateway", **extra):
    return capture("pre_approval_request", {"surface": surface, "tool_call_id": "reused", "command": "echo hi", **extra}, extra.get("digest", "digest"))


def post(surface="gateway", choice="once", **extra):
    return capture("post_approval_response", {"surface": surface, "choice": choice, **extra}, "digest")


def setup_function():
    reset()


def test_pairing_and_orphan():
    first = pre()
    assert post()["gateId"] == first["gateId"]
    assert post()["gateId"] is None


def test_threads_interleave_identical_commands():
    barrier = threading.Barrier(2)
    pairs = []
    def worker():
        request = pre()
        barrier.wait()
        response = post()
        pairs.append((request["gateId"], response["gateId"]))
    threads = [threading.Thread(target=worker) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len({a for a, _ in pairs}) == 2
    assert all(a == b for a, b in pairs)


def test_escalation_and_smart_deny_override():
    smart = pre("smart")
    human = pre()
    assert human["linkedGateId"] == smart["gateId"]
    assert post()["gateId"] == human["gateId"]
    smart = pre("smart")
    assert post("smart", "smart_deny")["gateId"] == smart["gateId"]
    assert pre()["linkedGateId"] == smart["gateId"]


def test_no_cross_link_after_a_new_tool_call():
    # A human prompt after a guardian deny in the same thread and tool call is Hermes's override of that gate
    # (approval.py:761); command digests differ by redaction, so they are not compared.
    pre("smart")
    post("smart", "smart_deny")
    assert pre(digest="different")["linkedGateId"] is not None
    pre("smart")
    post("smart", "smart_deny")
    capture("pre_tool_call", {}, None)
    assert pre()["linkedGateId"] is None
    pre("smart", digest="first")
    second = pre("smart", digest="second")
    assert pre(digest="second")["linkedGateId"] == second["gateId"]


def test_coalesced_follower_fresh_prompt():
    follower = pre(coalesced=True)
    fresh = pre()
    assert fresh["supersedesGateId"] == follower["gateId"]
    assert fresh["gateId"] != follower["gateId"]
    assert post()["gateId"] == fresh["gateId"]


def test_transport_id_moved_and_preserved_on_post():
    request = pre("transport:telegram", request_id="transport-1")
    assert "request_id" not in request
    assert request["transportRequestId"] == "transport-1"
    response = post("transport:telegram")
    assert response["transportRequestId"] == "transport-1"
    assert response["gateId"] == request["gateId"]


def test_bounded_and_fork_reset():
    ids = [pre()["gateId"] for _ in range(20)]
    assert [post()["gateId"] for _ in range(16)] == list(reversed(ids[-16:]))
    assert post()["gateId"] is None
    pre()
    reset()
    assert post()["gateId"] is None


def test_escalation_links_even_when_redaction_changes_the_command():
    reset()
    ids = {"tool_call_id": "t1", "turn_id": "u1", "session_id": "s1"}
    smart = capture("pre_approval_request", {**ids, "surface": "smart", "command": "curl -H [redacted]"}, "a" * 64)
    human = capture("pre_approval_request", {**ids, "surface": "gateway", "command": "curl -H token=***"}, "b" * 64)
    assert human["linkedGateId"] == smart["gateId"]


def test_tool_completions_carry_no_gate_ids():
    # Hermes runs tool hooks on other threads than approval hooks, so no exact gate link exists (gate review #3).
    capture("pre_tool_call", {}, None)
    pre()
    assert "gateIds" not in capture("post_tool_call", {}, None)
