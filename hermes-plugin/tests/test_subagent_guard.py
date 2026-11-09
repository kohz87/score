"""docs/briefs/SA-subagents.md: subagents stay inside their limits and out of the room."""
import json
import threading

import pytest
from score_bridge.subagent_guard import MAX_POLICY_BYTES, SubagentGuard, policy_path

SESSION = "score-room-job-lead"
CHILD = "20261109_182613_a02461"
ALLOWED = {"v": 1, "inline": True, "enabled": True, "maxConcurrent": 4, "maxTotal": 20, "used": 0}


ROWS = {}


def lineage(session_id):
    return ROWS.get(session_id)


@pytest.fixture(autouse=True)
def no_rows():
    ROWS.clear()


@pytest.fixture
def guard(tmp_path):
    return SubagentGuard(home=tmp_path, lineage=lineage)


def write(tmp_path, session=SESSION, **policy):
    path = policy_path(tmp_path, session)
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps({**ALLOWED, **policy}))
    return path


def delegate(guard, count=1, session=SESSION, **extra):
    return guard.pre_tool_call(
        tool_name="delegate_task",
        args={"tasks": [{"goal": str(n)} for n in range(count)], **extra},
        session_id=session,
    )


def message(result):
    assert result["action"] == "block"
    return result["message"]


def test_other_tools_pass_without_reading_anything(guard, tmp_path):
    assert guard.pre_tool_call(tool_name="terminal", args={"command": "ls"}, session_id=SESSION) is None
    assert guard.pre_tool_call(tool_name="terminal", args={}, session_id=CHILD) is None
    assert not (tmp_path / "subagents").exists()


def test_a_child_cannot_use_any_of_scores_tools(guard):
    guard.on_subagent_start(child_session_id=CHILD, parent_session_id=SESSION)
    for tool in (
        "score_reply",
        "score_handoff",
        "score_approve",
        "knowledge_write",
        "mcp_score_rooms_post",
        "mcp__score__orch_plan",
        "mcp__score__score_future_tool",
    ):
        assert "can't use Score" in message(guard.pre_tool_call(tool_name=tool, args={}, session_id=CHILD))


def test_the_parent_keeps_scores_tools(guard):
    guard.on_subagent_start(child_session_id=CHILD)
    for tool in ("score_reply", "score_handoff", "mcp__score__rooms_post"):
        assert guard.pre_tool_call(tool_name=tool, args={}, session_id=SESSION) is None


def test_a_child_cannot_delegate(guard, tmp_path):
    write(tmp_path, session=CHILD)
    guard.on_subagent_start(child_session_id=CHILD)
    assert message(delegate(guard, session=CHILD))


def test_a_batch_within_the_limit_passes(guard, tmp_path):
    write(tmp_path)
    assert delegate(guard, 4) is None


def test_a_batch_over_the_limit_is_stopped_and_says_so(guard, tmp_path):
    write(tmp_path, maxConcurrent=2)
    text = message(delegate(guard, 3))
    assert "limit is 2 subagents at once" in text and "asked for 3" in text


def test_the_legacy_single_goal_is_one_task(guard, tmp_path):
    write(tmp_path, maxConcurrent=1)
    assert guard.pre_tool_call(tool_name="delegate_task", args={"goal": "x"}, session_id=SESSION) is None


def test_off_for_the_job(guard, tmp_path):
    write(tmp_path, enabled=False)
    assert "off for this job" in message(delegate(guard))


def test_a_session_still_in_background_mode_is_refused(guard, tmp_path):
    write(tmp_path, inline=False)
    assert "started before" in message(delegate(guard))


def test_the_total_counts_across_calls(guard, tmp_path):
    write(tmp_path, maxTotal=5)
    assert delegate(guard, 3) is None
    assert delegate(guard, 2) is None
    assert "used 5 of its 5" in message(delegate(guard))


def test_a_refused_batch_is_not_counted(guard, tmp_path):
    write(tmp_path, maxTotal=5)
    assert delegate(guard, 4) is None
    assert message(delegate(guard, 2))
    assert delegate(guard, 1) is None


def test_the_total_takes_the_larger_of_scores_count_and_its_own(guard, tmp_path):
    write(tmp_path, maxTotal=5, used=4)
    assert delegate(guard) is None
    assert message(delegate(guard))
    # A fresh process has no count of its own: Score's holds the line after a restart.
    assert message(delegate(SubagentGuard(home=tmp_path, lineage=lineage), 2))


def test_a_change_applies_to_the_next_call(guard, tmp_path):
    write(tmp_path)
    assert delegate(guard, 3) is None
    write(tmp_path, maxConcurrent=2)
    assert message(delegate(guard, 3))


def test_concurrent_calls_cannot_pass_the_total_together(guard, tmp_path):
    write(tmp_path, maxTotal=3)
    results = []
    threads = [threading.Thread(target=lambda: results.append(delegate(guard))) for _ in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sum(result is None for result in results) == 3


def test_live_control_of_running_children_is_not_a_spawn(guard, tmp_path):
    write(tmp_path, enabled=False)
    for action in ("list", "steer", "stop"):
        assert guard.pre_tool_call(tool_name="delegate_task", args={"action": action}, session_id=SESSION) is None


def test_a_score_session_with_no_policy_is_refused(guard):
    for session in ("score-room-lead", "orc-1234-lead-1"):
        assert "no subagent limit" in message(delegate(guard, session=session))


def test_a_session_score_did_not_start_is_left_alone(guard):
    assert delegate(guard, 9, session="20261109_outside") is None
    assert delegate(guard, 9, session="") is None


def test_a_room_continuing_an_outside_session_follows_its_policy(guard, tmp_path):
    write(tmp_path, session="20261109_outside", enabled=False)
    assert message(delegate(guard, session="20261109_outside"))


@pytest.mark.parametrize(
    "content",
    [
        b"not json",
        b"[]",
        b'{"v": 2}',
        b'{"v": 1, "inline": true, "enabled": true}',
        b'{"v": 1, "inline": true, "enabled": true, "maxConcurrent": -1, "maxTotal": 1, "used": 0}',
        b'{"v": 1, "inline": true, "enabled": true, "maxConcurrent": true, "maxTotal": 1, "used": 0}',
        b"x" * (MAX_POLICY_BYTES + 1),
    ],
)
def test_a_policy_it_cannot_trust_refuses(guard, tmp_path, content):
    path = policy_path(tmp_path, SESSION)
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(content)
    assert "refused" in message(delegate(guard))


def test_an_unreadable_policy_refuses_only_delegation(guard, tmp_path):
    path = policy_path(tmp_path, SESSION)
    path.parent.mkdir(exist_ok=True)
    path.mkdir()  # reading a directory raises something other than "not found"
    assert "refused" in message(delegate(guard))
    assert guard.pre_tool_call(tool_name="terminal", args={}, session_id=SESSION) is None
    assert guard.pre_tool_call(tool_name="score_reply", args={}, session_id=SESSION) is None


def test_odd_input_never_raises(guard):
    assert guard.pre_tool_call() is None
    assert guard.pre_tool_call(tool_name=None, args=None, session_id=None) is None
    assert guard.pre_tool_call(tool_name=5, args=[], session_id=7) is None
    guard.on_subagent_start()
    guard.on_subagent_start(child_session_id=7)
    assert message(guard.pre_tool_call(tool_name="delegate_task", args=[], session_id="score-x"))


def test_a_task_list_sent_as_a_json_string_counts_each_task(guard, tmp_path):
    write(tmp_path, maxConcurrent=2)
    tasks = json.dumps([{"goal": str(n)} for n in range(3)])
    result = guard.pre_tool_call(tool_name="delegate_task", args={"tasks": tasks}, session_id=SESSION)
    assert "asked for 3" in message(result)
    assert guard.pre_tool_call(tool_name="delegate_task", args={"tasks": "not json"}, session_id=SESSION) is None


def test_a_stop_in_capitals_is_still_a_stop(guard, tmp_path):
    write(tmp_path, enabled=False)
    assert guard.pre_tool_call(tool_name="delegate_task", args={"action": " STOP "}, session_id=SESSION) is None


def test_a_child_is_told_why_it_cannot_delegate(guard, tmp_path):
    guard.on_subagent_start(child_session_id=CHILD)
    assert "start subagents of its own" in message(delegate(guard, session=CHILD))


def test_a_compressed_session_keeps_its_limits(guard, tmp_path):
    ROWS["tip"] = ("middle", "api_server")
    ROWS["middle"] = (SESSION, "api_server")
    ROWS[SESSION] = (None, "api_server")
    write(tmp_path, enabled=False)
    assert "off for this job" in message(delegate(guard, session="tip"))
    write(tmp_path, maxTotal=2)
    guard = SubagentGuard(home=tmp_path, lineage=lineage)
    assert delegate(guard, 2, session="tip") is None
    # The count follows the job across the new id.
    assert "used 2 of its 2" in message(delegate(guard, session="middle"))
    assert guard.policy_session("tip") == SESSION


def test_a_compressed_score_session_with_no_policy_is_refused(guard):
    ROWS["tip"] = (SESSION, "api_server")
    ROWS[SESSION] = (None, "api_server")
    assert "no subagent limit" in message(delegate(guard, session="tip"))


def test_a_compressed_subagent_stays_a_subagent_even_after_a_restart(guard):
    ROWS["child-tip"] = (CHILD, "subagent")
    ROWS[CHILD] = (SESSION, "subagent")
    ROWS[SESSION] = (None, "api_server")
    for tool in ("score_reply", "mcp__score__rooms_post"):
        assert "can't use Score" in message(guard.pre_tool_call(tool_name=tool, args={}, session_id="child-tip"))
    assert message(delegate(guard, session="child-tip"))


def test_an_outside_session_and_its_compression_stay_ungoverned(guard):
    ROWS["outside-tip"] = ("outside", "telegram")
    ROWS["outside"] = (None, "telegram")
    assert delegate(guard, 9, session="outside-tip") is None
    assert guard.pre_tool_call(tool_name="score_reply", args={}, session_id="outside-tip") is None


def test_a_row_that_appears_later_is_seen_later(guard, tmp_path):
    write(tmp_path, enabled=False)
    assert delegate(guard, session="tip") is None
    ROWS["tip"] = (SESSION, "api_server")
    ROWS[SESSION] = (None, "api_server")
    assert "off for this job" in message(delegate(guard, session="tip"))


def test_a_lineage_loop_ends(guard):
    ROWS["a"] = ("b", "api_server")
    ROWS["b"] = ("a", "api_server")
    assert delegate(guard, session="a") is None


def test_an_unreadable_lineage_refuses_score_tools_and_delegation_only(tmp_path):
    def broken(_session_id):
        raise OSError("locked")

    guard = SubagentGuard(home=tmp_path, lineage=broken)
    assert "refused" in message(delegate(guard, session="tip"))
    assert "refused" in message(guard.pre_tool_call(tool_name="score_reply", args={}, session_id="tip"))
    assert guard.pre_tool_call(tool_name="terminal", args={}, session_id="tip") is None


def test_scores_own_ids_need_no_lookup(tmp_path):
    def forbidden(_session_id):
        raise AssertionError("looked up")

    guard = SubagentGuard(home=tmp_path, lineage=forbidden)
    write(tmp_path)
    assert delegate(guard) is None


def test_the_own_count_gives_way_to_scores_as_it_catches_up(guard, tmp_path):
    write(tmp_path, maxTotal=5)
    assert delegate(guard, 3) is None
    write(tmp_path, maxTotal=5, used=3)
    assert delegate(guard, 2) is None
    assert message(delegate(guard))


def test_a_lower_count_from_score_starts_the_own_count_again(guard, tmp_path):
    write(tmp_path, maxTotal=3, used=2)
    assert delegate(guard) is None
    assert message(delegate(guard))
    write(tmp_path, maxTotal=3, used=0)
    assert delegate(guard, 3) is None


def test_a_raised_total_lets_more_through(guard, tmp_path):
    write(tmp_path, maxTotal=1)
    assert delegate(guard) is None
    assert message(delegate(guard))
    write(tmp_path, maxTotal=2)
    assert delegate(guard) is None
