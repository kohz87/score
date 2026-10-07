import stat
from concurrent.futures import ThreadPoolExecutor

import pytest

from score_bridge.client import ScoreClient
from score_bridge.sender import Sender
from score_bridge.spool import Spool, gap_event
from helpers import FakeTransport


def event(counter, padding=0, *, at="2026-10-07T00:00:00.000Z"):
    return {"counter": counter, "hook": "pre_tool_call", "at": at,
            "sessionKey": None, "sessionId": None, "toolCallId": None,
            "payload": {"text": "x" * padding}}


def test_permissions_ack_and_delete(tmp_path):
    spool = Spool("producer", tmp_path / "spool")
    spool.append([event(1), event(2)])
    assert stat.S_IMODE(spool.directory.stat().st_mode) == 0o700
    assert stat.S_IMODE(spool.path.stat().st_mode) == 0o600
    assert stat.S_IMODE((spool.directory / ".lock").stat().st_mode) == 0o600
    spool.acknowledge(1)
    assert spool.peek() == [event(2)]
    spool.acknowledge(2)
    assert spool.peek() == [] and not spool.path.exists()


def test_file_cap_gap_survives_recreation_and_merges(tmp_path):
    spool = Spool("producer", tmp_path, file_cap=1024, directory_cap=4096)
    for counter in range(1, 6):
        spool.append([event(counter, 500)])
        assert spool.path.stat().st_size <= 1024
    assert spool.dropped == 4
    restarted = Spool("producer", tmp_path, file_cap=1024, directory_cap=4096)
    gap = restarted.pending_gap()
    assert gap["counter"] == 4 and gap["hook"] == "bridge.gap"
    assert gap["payload"] == {"from_counter": 1, "to_counter": 4, "dropped": 4}
    assert restarted.peek() == [event(5, 500)]


def test_oversized_batch_is_replaced_by_gap(tmp_path):
    spool = Spool("producer", tmp_path, file_cap=1024, directory_cap=4096)
    spool.append([event(1, 2000), event(2, 2000)])
    assert spool.path.stat().st_size <= 1024
    gap = spool.pending_gap()
    assert gap["hook"] == "bridge.gap" and gap["payload"]["to_counter"] == 2
    assert spool.dropped == 2


def test_directory_cap_drops_oldest_producer_lines(tmp_path):
    old = Spool("old", tmp_path, file_cap=2048, directory_cap=2400)
    new = Spool("new", tmp_path, file_cap=2048, directory_cap=2400)
    old.append([event(1, 650), event(2, 650)])
    new.append([event(1, 650, at="2026-10-07T01:00:00.000Z"), event(2, 650, at="2026-10-07T01:00:00.000Z")])
    assert sum(path.stat().st_size for path in tmp_path.glob("*.jsonl")) <= 2400
    assert old.pending_gap()["hook"] == "bridge.gap"
    assert new.peek()[0]["hook"] == "pre_tool_call"


def test_gap_sent_before_retained_events_after_cap(tmp_path):
    transport = FakeTransport()
    transport.down = True
    token = tmp_path / "token"
    token.write_text("bootstrap")
    client = ScoreClient(token_path=token, transport=transport)
    sender = Sender(client, Spool(client.incarnation, tmp_path / "spool", file_cap=3000, directory_cap=5000))
    for _ in range(5):
        sender.enqueue("pre_tool_call", (), {"result": "x" * 700})
        sender.process_once()
    assert sender.spool.path.stat().st_size <= 3000
    transport.down = False
    sender.process_once()
    assert any(e["hook"] == "bridge.gap" for e in transport.acked)
    assert [e["counter"] for e in transport.acked] == sorted({e["counter"] for e in transport.acked})
    assert transport.acked[-1]["counter"] >= 6
    assert not sender.spool.path.exists()


def test_symlinks_never_followed(tmp_path):
    target = tmp_path / "target"
    target.write_text("untouched")
    spool = Spool("producer", tmp_path / "spool")
    spool.directory.mkdir()
    spool.path.symlink_to(target)
    with pytest.raises(OSError):
        spool.append([event(1)])
    assert target.read_text() == "untouched"


def test_concurrent_producers_enforce_directory_cap(tmp_path):
    def produce(name):
        spool = Spool(name, tmp_path, file_cap=2048, directory_cap=6000)
        for counter in range(1, 11):
            spool.append([event(counter, 500)])
    with ThreadPoolExecutor(max_workers=3) as executor:
        list(executor.map(produce, ["one", "two", "three"]))
    assert sum(path.stat().st_size for path in tmp_path.glob("*.jsonl")) <= 6000
    for name in ["one", "two", "three"]:
        spool = Spool(name, tmp_path)
        gap = spool.pending_gap()
        assert gap["hook"] == "bridge.gap"
        assert gap["payload"]["from_counter"] == 1


def test_exited_producer_recovers_original_identity_independently(tmp_path):
    token = tmp_path / "token"
    token.write_text("bootstrap")
    transport = FakeTransport()
    old_client = ScoreClient(token_path=token, transport=transport)
    identity = old_client.identity()
    identity["pid"] = 999_999_999
    old = Spool(old_client.incarnation, tmp_path / "spool")
    old.producer = identity
    old.append([event(1), event(2)])
    client = ScoreClient(token_path=token, transport=transport)
    sender = Sender(client, Spool(client.incarnation, old.directory))
    sender.enqueue("pre_tool_call", (), {})
    sender.process_once()
    hellos = [call[2] for call in transport.calls if call[0].endswith("/hello")]
    assert [req["incarnation"] for req in hellos] == [client.incarnation, old_client.incarnation]
    assert hellos[1]["pid"] == identity["pid"]
    assert [e["counter"] for e in transport.acked] == [1, 1, 2]
    assert not old.path.exists()


def test_active_producer_not_replayed_by_another_process(tmp_path):
    client = ScoreClient(transport=FakeTransport())
    active = Spool(client.incarnation, tmp_path)
    active.producer = client.identity()
    active.append([event(1)])
    other = Spool("other", tmp_path)
    assert other.recoverable() == []


def test_path_traversal_and_impossible_caps_rejected(tmp_path):
    with pytest.raises(ValueError):
        Spool("../escape", tmp_path)
    with pytest.raises(ValueError):
        Spool("producer", tmp_path, file_cap=20)


def test_existing_gap_range_preserved_when_evicted_with_batch(tmp_path):
    spool = Spool("producer", tmp_path, file_cap=1024, directory_cap=2048)
    spool.append([gap_event(1, 10, "2026-10-07T00:00:00.000Z"), event(11, 2000)])
    assert spool.pending_gap()["payload"]["from_counter"] == 1
    assert spool.pending_gap()["payload"]["to_counter"] == 11


def test_pending_gap_survives_ack_and_preserves_counter_high_water(tmp_path):
    spool = Spool("producer", tmp_path, file_cap=1024, directory_cap=2048)
    spool.append([event(1, 2000)])
    spool.append([event(2, 50)])
    spool.acknowledge(2)
    assert spool.peek() == []
    assert spool.pending_gap()["payload"]["from_counter"] == 1
    restarted = Spool("producer", tmp_path, file_cap=1024, directory_cap=2048)
    assert restarted.next_counter() == 3
    marker = restarted.pending_gap()
    marker["counter"] = restarted.next_counter()
    restarted.append([marker], reported_gap=(1, 1))
    assert restarted.pending_gap() is None
    assert restarted.peek()[0]["counter"] == 3


def test_gap_only_directory_remains_bounded_and_reports_history_loss(tmp_path):
    for counter in range(10):
        spool = Spool(f"producer-{counter}", tmp_path, file_cap=1024, directory_cap=1024)
        spool.append([event(1, 2000)])
    assert sum(path.stat().st_size for path in tmp_path.glob("*.jsonl")) <= 1024
    assert any(Spool(path.stem, tmp_path).history_evicted()
               for path in tmp_path.glob("*.jsonl"))


def test_exited_producer_gap_gets_counter_above_previously_acked_events(tmp_path):
    transport = FakeTransport()
    token = tmp_path / "token"
    token.write_text("bootstrap")
    old_client = ScoreClient(token_path=token, transport=transport)
    identity = old_client.identity()
    identity["pid"] = 999_999_999
    old = Spool(old_client.incarnation, tmp_path / "spool", file_cap=2048, directory_cap=4096)
    old.producer = identity
    old.append([event(1, 2000)])
    old.append([event(2)])
    old.acknowledge(2)
    client = ScoreClient(token_path=token, transport=transport)
    sender = Sender(client, Spool(client.incarnation, old.directory))
    sender.process_once()
    assert transport.acked[-1]["hook"] == "bridge.gap"
    assert transport.acked[-1]["counter"] == 3
    assert not old.path.exists()


def test_stale_temporary_files_cleaned_under_directory_lock(tmp_path):
    (tmp_path / ".outbox-crashed").write_text("x" * 10_000)
    spool = Spool("producer", tmp_path)
    spool.append([event(1)])
    assert not (tmp_path / ".outbox-crashed").exists()


def test_gap_materialization_is_atomic_across_recovering_processes(tmp_path):
    initial = Spool("producer", tmp_path, file_cap=1024, directory_cap=2048)
    initial.append([event(1, 2000)])
    def recover(_):
        return Spool("producer", tmp_path).materialize_gap()
    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(recover, range(3)))
    assert results.count(True) == 1
    assert initial.peek()[0]["counter"] == 2
    assert initial.pending_gap() is None
