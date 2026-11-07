"""Regression probes for admission, contention and gap findings."""

import time

from score_bridge.sender import merge_ranges
from helpers import make_hook


def test_01_eviction_does_not_release_foreign_objects(setup):
    sender, _ = setup
    sender.queue.maxsize = 1
    destroyed = []
    class Slow:
        def __del__(self):
            destroyed.append(True)
            time.sleep(0.1)
    hook = make_hook("pre_tool_call", sender)
    hook(result=Slow())
    assert destroyed == [True]  # Ownership ends at capture, never in the outbox.
    started = time.perf_counter()
    hook(result="replacement")
    assert time.perf_counter() - started < 0.001
    assert sender.dropped == 1


def test_01_admission_contention_has_two_ms_budget_and_reports_loss(setup):
    sender, transport = setup
    hook = make_hook("pre_tool_call", sender)
    sender.queue.mutex.acquire()
    try:
        started = time.monotonic()
        hook(command="echo hello")
        assert time.monotonic() - started < 0.02
        assert sender.contended == 1
    finally:
        sender.queue.mutex.release()
    hook(command="echo next")
    sender.process_once()
    assert transport.acked[0]["hook"] == "bridge.gap"
    assert transport.acked[0]["payload"]["dropped"] == 1
    assert transport.acked[1]["hook"] == "pre_tool_call"


def test_01_all_contention_losses_counted_when_metadata_overflows(setup):
    sender, transport = setup
    sender.contended = 30_001
    sender._contention.extend([sender.client.profile] * 10_000)
    sender.process_once()
    assert transport.acked[0]["payload"]["dropped"] == 30_001


def test_12_queue_gap_is_first_batch_under_sustained_traffic(setup):
    sender, transport = setup
    sender.queue.maxsize = 2
    for i in range(10):
        sender.enqueue("pre_tool_call", (), {"command": str(i)})
    sender.process_once()
    assert transport.event_calls[0][0]["hook"] == "bridge.gap"
    assert transport.event_calls[0][0]["payload"]["dropped"] == 8
    assert len(transport.event_calls[0]) == 3
    assert [e["counter"] for e in transport.acked] == [9, 10, 11]


def test_12_range_metadata_is_merged_and_bounded():
    ranges = []
    for i in range(1000):
        merge_ranges(ranges, i * 3 + 1, i * 3 + 1, "at")
    assert len(ranges) <= 100
    assert ranges[0][0] == 1 and ranges[-1][1] == 2998
    merge_ranges(ranges, 1, 2999, "at")
    assert ranges == [(1, 2999, "at")]


def test_12_spool_gap_precedes_new_events_with_busy_queue(setup):
    sender, transport = setup
    sender.spool.file_cap = 3000
    sender.spool.directory_cap = 6000
    transport.down = True
    for _ in range(5):
        sender.enqueue("post_tool_call", (), {"result": "x" * 700})
        sender.process_once()
    transport.down = False
    sender.enqueue("pre_tool_call", (), {"command": "fresh"})
    sender.process_once()
    hooks = [e["hook"] for e in transport.acked]
    assert "bridge.gap" in hooks
    fresh = next(i for i, e in enumerate(transport.acked) if e["payload"].get("command") == "fresh")
    assert hooks.index("bridge.gap") < fresh
    assert [e["counter"] for e in transport.acked] == sorted({e["counter"] for e in transport.acked})
