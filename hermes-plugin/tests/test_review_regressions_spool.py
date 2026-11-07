"""Regression probes for spool corruption, orphan recovery and permissions."""

import json
import os
from urllib.error import HTTPError

import pytest

from score_bridge.client import ScoreClient
from score_bridge.spool import Spool, _valid_event, encode
from test_spool import event


def test_09_corrupt_binary_records_count_and_persist_loss(tmp_path):
    spool = Spool("producer", tmp_path, file_cap=2048, directory_cap=4096)
    spool.path.write_bytes(b"\xff\nnot-json\n" + encode([event(1)]))
    assert spool.peek() == [event(1)]
    assert spool.corrupt == spool.dropped == 2
    restored = Spool("producer", tmp_path)
    marker = restored.pending_gap()
    assert marker["payload"]["corrupt_records"] == 2
    assert spool.path.stat().st_size <= 2048
    assert b"not-json" not in spool.path.read_bytes()
    assert restored.peek() == [event(1)]


def test_09_caps_use_physical_bytes_and_reads_are_bounded(tmp_path, monkeypatch):
    spool = Spool("producer", tmp_path, file_cap=2048, directory_cap=4096)
    (tmp_path / "oversize.jsonl").write_bytes(b"\xff\n" * 5000)
    (tmp_path / "whitespace.jsonl").write_bytes(b" " * 5000 + encode([event(1)]))
    import score_bridge.spool as module
    original = module.os.fdopen
    reads = []
    class BinaryReader:
        def __init__(self, stream):
            self.stream = stream
        def __enter__(self):
            self.stream.__enter__()
            return self
        def __exit__(self, *args):
            return self.stream.__exit__(*args)
        def fileno(self):
            return self.stream.fileno()
        def read(self, size):
            reads.append(size)
            assert size <= spool.file_cap
            return self.stream.read(size)
    monkeypatch.setattr(module.os, "fdopen", lambda fd, mode, **kw: BinaryReader(original(fd, mode, **kw))
                        if mode == "rb" else original(fd, mode, **kw))
    spool.append([event(1)])
    assert reads
    assert sum(p.stat().st_size for p in tmp_path.glob("*.jsonl")) <= spool.directory_cap
    assert all(p.stat().st_size <= spool.file_cap for p in tmp_path.glob("*.jsonl"))
    assert spool.corrupt > 0
    assert Spool("oversize", tmp_path, file_cap=2048, directory_cap=4096).pending_gap()["payload"]["corrupt_records"] > 0


def test_10_hook_cannot_forge_spool_flags(setup):
    sender, transport = setup
    payload = {"_pending_gap": True, "_internal": "raw", "args": {"command": "echo hello", "_control": True}}
    sender.enqueue("pre_tool_call", (), payload)
    sender.process_once()
    assert len(transport.acked) == 1
    assert transport.acked[0]["payload"]["args"] == {"command": "echo hello"}
    assert "_pending_gap" not in json.dumps(transport.acked)
    assert not sender.spool.path.exists()


def test_10_spool_never_interprets_hook_payload_as_envelope(tmp_path):
    spool = Spool("producer", tmp_path)
    ordinary = event(1)
    ordinary["payload"] = {"_pending_gap": True, "args": {"command": "echo hello"}}
    spool.append([ordinary])
    assert spool.peek() == [ordinary] and spool.pending_gap() is None
    malformed = event(2)
    malformed["hook"] = "bridge.gap"
    assert not _valid_event(malformed)


@pytest.mark.parametrize("status", [401, 403, 404, 503])
def test_11_rejected_orphan_does_not_block_current_producer(setup, status):
    sender, transport = setup
    old_client = ScoreClient(token_path=sender.client.token_path, transport=transport)
    identity = old_client.identity()
    identity["pid"] = 999_999_999
    old = Spool(old_client.incarnation, sender.spool.directory)
    old.producer = identity
    old.append([event(1)])
    old_calls = []
    def reject_old(url, token, body, timeout):
        if url.endswith("hello") and body["incarnation"] == old_client.incarnation:
            old_calls.append(body)
            raise HTTPError(url, status, "rejected", {}, None)
        return transport(url, token, body, timeout)
    sender.client.transport = reject_old
    sender.enqueue("pre_tool_call", (), {"command": "echo current"})
    sender.process_once()
    assert transport.acked[0]["payload"]["command"] == "echo current"
    sender.process_once()
    assert len(old_calls) == 1  # Per-orphan backoff or quarantine.
    if status != 503:
        assert not old.path.exists()
        assert (old.directory / "quarantine" / old.path.name).exists()
        assert sender.quarantined == 1
    else:
        assert old.path.exists() and sender.quarantined == 0


def test_11_slow_orphan_is_attempted_after_healthy_sends(setup):
    sender, transport = setup
    old_client = ScoreClient(transport=transport)
    old = Spool(old_client.incarnation, sender.spool.directory)
    identity = old_client.identity()
    identity["pid"] = 999_999_999
    old.producer = identity
    old.append([event(1)])
    def orphan_timeout(url, token, body, timeout):
        if url.endswith("hello") and body["incarnation"] == old_client.incarnation:
            assert transport.acked, "orphan delayed a healthy send"
            raise TimeoutError()
        return transport(url, token, body, timeout)
    sender.client.transport = orphan_timeout
    sender.enqueue("pre_tool_call", (), {"command": "echo healthy"})
    sender.process_once()
    assert transport.acked[0]["payload"]["command"] == "echo healthy"


def test_11_quarantine_shares_physical_directory_quota(tmp_path):
    old = Spool("old", tmp_path, file_cap=2048, directory_cap=2400)
    old.append([event(1, 650), event(2, 650)])
    old.quarantine()
    new = Spool("new", tmp_path, file_cap=2048, directory_cap=2400)
    new.append([event(1, 650), event(2, 650)])
    assert sum(p.stat().st_size for p in tmp_path.rglob("*.jsonl")) <= 2400
    assert new.peek() == [event(1, 650), event(2, 650)]


@pytest.mark.parametrize("component", ["parent", "spool"])
@pytest.mark.parametrize("mode", [0o720, 0o702])
def test_14_unsafe_directory_permissions_refuse_spooling(tmp_path, component, mode):
    parent = tmp_path / "score"
    parent.mkdir(mode=0o700)
    directory = parent / "spool"
    directory.mkdir(mode=0o700)
    (parent if component == "parent" else directory).chmod(mode)
    spool = Spool("producer", directory)
    with pytest.raises(OSError):
        spool.append([event(1)])
    assert spool.refused == 1 and not spool.path.exists()


def test_14_foreign_owner_refused_and_plugin_stays_fail_open(setup, monkeypatch):
    sender, transport = setup
    monkeypatch.setattr(os, "getuid", lambda: os.geteuid() + 1)
    sender.enqueue("post_tool_call", (), {"result": "text"})
    sender.process_once()
    assert sender.dropped == 1
    assert sender.spool.refused > 0 and transport.calls == []
    assert not sender.spool.path.exists()
