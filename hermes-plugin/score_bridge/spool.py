"""Private, physically bounded JSONL outbox with durable envelope loss metadata."""
from __future__ import annotations

import fcntl
import json
import os
import re
import stat
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .client import score_home

FILE_CAP = 5 * 1024 * 1024
DIRECTORY_CAP = 50 * 1024 * 1024
# Close every inherited lock descriptor in the child without acquiring inherited locks.
_OPEN_FDS: set[int] = set()


def close_inherited_descriptors():
    for fd in tuple(_OPEN_FDS):
        try:
            os.close(fd)
        except OSError:
            pass
    _OPEN_FDS.clear()


def process_start(pid):
    """Boot id plus the kernel start time of ``pid``: what makes a recycled pid distinguishable.

    None where /proc is unavailable or the process is gone; callers then fall back to the pid alone."""
    try:
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        raw = Path(f"/proc/{int(pid)}/stat").read_text()
        # comm may contain spaces and parentheses; the fields after the last ")" are fixed.
        start = int(raw[raw.rindex(")") + 2:].split()[19])
    except (OSError, ValueError, IndexError):
        return None
    return {"boot": boot, "start": start} if boot else None


def _valid_start(start):
    return (isinstance(start, dict) and set(start) == {"boot", "start"}
            and isinstance(start["boot"], str) and type(start["start"]) is int)


def encode(events, producer=None, last_counter=0, *, pending_gap=False, history_evicted=False, start=None):
    record = {"events": events, "lastCounter": last_counter}
    if producer is not None:
        record["producer"] = producer
    if start is not None:
        record["start"] = start
    if pending_gap:
        record["pendingGap"] = True
    if history_evicted:
        record["producerHistoryEvicted"] = True
    return (json.dumps(record, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n").encode()


def _invalid_constant(value):
    raise ValueError("non-finite JSON number")


def gap_event(first: int, last: int, at: str) -> dict:
    return {"counter": last, "hook": "bridge.gap", "at": at,
            "sessionKey": None, "sessionId": None, "toolCallId": None,
            "payload": {"from_counter": first, "to_counter": last, "dropped": last - first + 1}}


def _valid_gap(event):
    payload = event["payload"]
    first, last, dropped = (payload.get(key) for key in ("from_counter", "to_counter", "dropped"))
    corrupt = payload.get("corrupt_records", 0)
    return (type(first) is int and type(last) is int and 0 < first <= last
            and type(dropped) is int and dropped == last - first + 1
            and type(corrupt) is int and corrupt >= 0
            and set(payload) <= {"from_counter", "to_counter", "dropped", "corrupt_records"})


def _valid_event(event: object) -> bool:
    if (not isinstance(event, dict) or type(event.get("counter")) is not int
            or event["counter"] <= 0 or not isinstance(event.get("hook"), str)
            or not event["hook"] or not isinstance(event.get("at"), str)
            or not isinstance(event.get("payload"), dict)):
        return False
    for key in ("sessionKey", "sessionId", "toolCallId"):
        if key not in event or (event[key] is not None and
                                (not isinstance(event[key], str) or not event[key])):
            return False
    if event["hook"] == "bridge.gap" and not _valid_gap(event):
        return False
    try:
        return datetime.fromisoformat(event["at"].replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def _valid_producer(producer: dict, incarnation: str) -> bool:
    hermes, apis, task = (producer.get(key) for key in ("hermes", "privateApis", "kanbanTaskId"))
    return (producer.get("incarnation") == incarnation
            and type(producer.get("pid")) is int and producer["pid"] > 0
            and isinstance(producer.get("profile"), str) and bool(producer["profile"])
            and producer.get("isolation") in ("host", "in_process", "unknown")
            and isinstance(producer.get("pluginVersion"), str)
            and (task is None or isinstance(task, str) and bool(task))
            and isinstance(hermes, dict)
            and all(isinstance(hermes.get(key), str) for key in ("version", "codeSha"))
            and isinstance(apis, dict)
            and all(isinstance(key, str) and type(value) is bool for key, value in apis.items()))


class Spool:
    def __init__(self, incarnation, directory=None, *, file_cap=FILE_CAP, directory_cap=DIRECTORY_CAP):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", incarnation):
            raise ValueError("invalid incarnation")
        if file_cap < 1024 or directory_cap < file_cap:
            raise ValueError("caps must leave room for a gap record")
        self.directory = Path(directory) if directory else score_home() / "spool"
        self.path = self.directory / f"{incarnation}.jsonl"
        self.file_cap, self.directory_cap = file_cap, directory_cap
        self.dropped = self.corrupt = self.refused = self.quarantined = 0
        self.producer = None
        self._identities = {}
        self._starts = {}
        self._verified = {}
        self._high_water = {}
        self.deadline = None

    def _check_deadline(self):
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise TimeoutError("spool budget exhausted")

    @contextmanager
    def _locked(self):
        self._check_deadline()
        self.directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._safe_directory(self.directory.parent)
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self._safe_directory(self.directory)
        self.directory.chmod(0o700)
        fd = os.open(self.directory / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        _OPEN_FDS.add(fd)
        try:
            os.fchmod(fd, 0o600)
            # Shutdown must also respect locks held by a different bridge process.
            while True:
                self._check_deadline()
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(0.001)
            present = set(self.directory.glob("*.jsonl"))
            self._identities = {p: v for p, v in self._identities.items() if p in present}
            self._high_water = {p: v for p, v in self._high_water.items() if p in present}
            self._starts = {p: v for p, v in self._starts.items() if p in present}
            self._verified = {p: v for p, v in self._verified.items() if p in present}
            stale = list(self.directory.glob(".outbox-*"))
            for temporary in stale:
                temporary.unlink(missing_ok=True)
            if stale:
                self._fsync_directory(self.directory)
            yield
        finally:
            _OPEN_FDS.discard(fd)
            os.close(fd)

    def _fsync_directory(self, directory):
        # A rename or unlink is only durable once the parent directory entry is flushed.
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _signature(self, path):
        info = path.stat()
        return (info.st_mtime_ns, info.st_size, info.st_ino)

    def _safe_directory(self, path):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            self.refused += 1
            raise OSError("unsafe spool directory ownership or permissions")

    def _read(self, path):
        self._check_deadline()
        if not path.exists():
            return []
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        _OPEN_FDS.add(fd)
        try:
            with os.fdopen(fd, "rb") as stream:
                physical_size = os.fstat(stream.fileno()).st_size
                data = stream.read(self.file_cap)
        finally:
            _OPEN_FDS.discard(fd)
        records, corrupt = [], 0
        for line in data.splitlines():
            self._check_deadline()
            try:
                record = json.loads(line.decode("utf-8"), parse_constant=_invalid_constant)
                if not isinstance(record, dict):
                    raise ValueError()
                high = record.get("lastCounter", 0)
                if type(high) is not int or high < 0:
                    raise ValueError()
                producer = record.get("producer")
                if producer is not None:
                    if not isinstance(producer, dict) or not _valid_producer(producer, path.stem):
                        raise ValueError()
                batch = record["events"]
                if (not isinstance(batch, list) or not batch or len(batch) > 200
                        or not all(_valid_event(e) for e in batch)
                        or any(a["counter"] >= b["counter"] for a, b in zip(batch, batch[1:]))):
                    raise ValueError()
                if (type(record.get("pendingGap", False)) is not bool
                        or type(record.get("producerHistoryEvicted", False)) is not bool
                        or record.get("pendingGap") and (len(batch) != 1 or batch[0]["hook"] != "bridge.gap")):
                    raise ValueError()
                start = record.get("start")
                if start is not None and not _valid_start(start):
                    raise ValueError()
                if producer is not None:
                    self._identities[path] = producer
                if start is not None:
                    self._starts[path] = start
                self._high_water[path] = max(self._high_water.get(path, 0), high, batch[-1]["counter"])
                records.append({"events": batch, "pendingGap": record.get("pendingGap", False),
                                "producerHistoryEvicted": record.get("producerHistoryEvicted", False)})
            except (ValueError, KeyError, TypeError, RecursionError):
                corrupt += 1
        if physical_size > len(data):
            corrupt += 1  # Unknown tail: count one loss indication, never read beyond the cap.
        if corrupt:
            self.corrupt += corrupt
            self.dropped += corrupt
            at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            # Corrupt records have unknown ingest identities; use a fresh, explicit loss range.
            first = self._high_water.get(path, 0) + 1
            self._high_water[path] = first + corrupt - 1
            marker = gap_event(first, first + corrupt - 1, at)
            marker["payload"]["corrupt_records"] = corrupt
            records = self._merge_marker(records, marker)
            self._fit_file(path, records)
            self._write(path, records)
        return records

    def _encoded(self, path, record):
        return encode(record["events"], self._identities.get(path), self._high_water.get(path, 0),
                      pending_gap=record.get("pendingGap", False),
                      history_evicted=record.get("producerHistoryEvicted", False),
                      start=self._starts.get(path))

    def _size(self, path, records):
        return sum(len(self._encoded(path, record)) for record in records)

    def _write(self, path, records):
        self._check_deadline()
        if not records:
            path.unlink(missing_ok=True)
            self._verified.pop(path, None)
            self._fsync_directory(self.directory)
            return
        fd, temporary = tempfile.mkstemp(prefix=".outbox-", dir=self.directory)
        _OPEN_FDS.add(fd)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(fd, 0o600)
                for record in records:
                    self._check_deadline()
                    stream.write(self._encoded(path, record))
                stream.flush()
                os.fsync(fd)
            _OPEN_FDS.discard(fd)
            os.replace(temporary, path)
            temporary = None
            self._fsync_directory(self.directory)
            self._verified[path] = self._signature(path)
        finally:
            _OPEN_FDS.discard(fd)
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)

    def _merge_marker(self, records, marker, *, history=False):
        ordinary = []
        for record in records:
            if record.get("pendingGap"):
                old = record["events"][0]["payload"]
                payload = marker["payload"]
                first = min(payload["from_counter"], old["from_counter"])
                last = max(payload["to_counter"], old["to_counter"])
                payload.update(from_counter=first, to_counter=last, dropped=last - first + 1)
                payload["corrupt_records"] = payload.get("corrupt_records", 0) + old.get("corrupt_records", 0)
                if not payload["corrupt_records"]:
                    payload.pop("corrupt_records")
                marker["counter"] = last
                history |= record.get("producerHistoryEvicted", False)
            else:
                ordinary.append(record)
        return [{"events": [marker], "pendingGap": True, "producerHistoryEvicted": history}] + ordinary

    def _drop_prefix(self, records):
        index = next((i for i, r in enumerate(records) if not r.get("pendingGap")), None)
        if index is None:
            return False
        removed = records.pop(index)["events"]
        first = min(e["payload"]["from_counter"] if e["hook"] == "bridge.gap" else e["counter"] for e in removed)
        last = max(e["payload"]["to_counter"] if e["hook"] == "bridge.gap" else e["counter"] for e in removed)
        self.dropped += sum(e["payload"]["dropped"] if e["hook"] == "bridge.gap" else 1 for e in removed)
        records[:] = self._merge_marker(records, gap_event(first, last, removed[-1]["at"]))
        return True

    def _fit_file(self, path, records):
        while self._size(path, records) > self.file_cap:
            if not self._drop_prefix(records):
                raise ValueError("loss metadata exceeds spool cap")

    def append(self, events, *, reported_gap=None):
        if not events:
            return
        if len(events) > 200 or not all(_valid_event(e) for e in events):
            raise ValueError("invalid event batch")
        with self._locked():
            if self.producer is not None:
                self._identities[self.path] = self.producer
                start = process_start(self.producer["pid"])
                if start is not None:
                    self._starts[self.path] = start
            records = self._read(self.path)
            self._high_water[self.path] = max(self._high_water.get(self.path, 0), events[-1]["counter"])
            if reported_gap:
                records = [r for r in records if not r.get("pendingGap") or
                           r["events"][0]["payload"]["to_counter"] > reported_gap[1]]
            records.append({"events": events})
            self._fit_file(self.path, records)
            self._write(self.path, records)
            self._enforce_directory()

    def _enforce_directory(self):
        paths = [p for p in self.directory.glob("*.jsonl") if not p.is_symlink()]
        for path in paths:
            # Only files that changed since this process last saw them are re-read; and a re-read file is
            # rewritten only when its bytes are not already what the loss-aware encoding would produce.
            if self._verified.get(path) == self._signature(path):
                continue
            records = self._read(path)
            self._fit_file(path, records)
            if not records or self._size(path, records) != path.stat().st_size:
                self._write(path, records)
            else:
                self._verified[path] = self._signature(path)
        files = {}
        quarantine = self.directory / "quarantine"
        quarantined = []
        if quarantine.exists():
            self._safe_directory(quarantine)
            quarantined = sorted(quarantine.glob("*.jsonl"), key=lambda p: p.stat().st_mtime_ns)
        for path in tuple(quarantined):
            if path.stat().st_size > self.file_cap:
                path.unlink()
                self._fsync_directory(quarantine)
                quarantined.remove(path)
                self.dropped += 1
        def total():
            return (sum(p.stat().st_size for p in paths if p.exists())
                    + sum(p.stat().st_size for p in quarantined))
        if total() > self.directory_cap:
            # Eviction needs the records; load them only when the directory is actually over its cap.
            for path in paths:
                records = self._read(path) if path.exists() else []
                if records:
                    files[path] = records
        while total() > self.directory_cap:
            self._check_deadline()
            if quarantined:
                quarantined.pop(0).unlink()
                self._fsync_directory(quarantine)
                self.dropped += 1
                continue
            candidates = [p for p, records in files.items() if any(not r.get("pendingGap") for r in records)]
            if candidates:
                path = min(candidates, key=lambda p: files[p][0]["events"][0]["at"])
                self._drop_prefix(files[path])
                self._write(path, files[path])
            else:
                path = min((p for p in files if p != self.path), default=self.path,
                           key=lambda p: files[p][0]["events"][0]["at"])
                self.dropped += 1
                del files[path]
                self._write(path, [])
                if files:
                    retained = self.path if self.path in files else next(iter(files))
                    files[retained][0]["producerHistoryEvicted"] = True
                    self._write(retained, files[retained])

    @staticmethod
    def _producer_alive(pid, recorded):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass  # exists, but owned by someone else: judged by its start identity below
        current = process_start(pid) if recorded is not None else None
        # The pid is held by a different process (recycled, or after a reboot): the producer is gone.
        return current is None or current == recorded

    def recoverable(self):
        with self._locked():
            self._enforce_directory()
            identities = []
            for path in self.directory.glob("*.jsonl"):
                if path == self.path or path.is_symlink():
                    continue
                records = self._read(path)
                producer = self._identities.get(path)
                if not records or producer is None:
                    continue
                if not self._producer_alive(producer["pid"], self._starts.get(path)):
                    identities.append((records[0]["events"][0]["at"], producer))
            return [p for _, p in sorted(identities, key=lambda entry: entry[0])]

    def peek(self, after=0):
        with self._locked():
            records = self._read(self.path)
            return next(([e for e in r["events"] if e["counter"] > after]
                         for r in records if not r.get("pendingGap") and r["events"][-1]["counter"] > after), [])

    def pending_gap(self):
        with self._locked():
            records = self._read(self.path)
            return next((r["events"][0] for r in records if r.get("pendingGap")), None)

    def history_evicted(self):
        with self._locked():
            return any(r.get("producerHistoryEvicted") for r in self._read(self.path))

    def materialize_gap(self):
        # Existing durable events cannot be renumbered after a lost acknowledgement.
        # Append a fresh report after that immutable history, ahead of new observations.
        with self._locked():
            records = self._read(self.path)
            marker = next((r for r in records if r.get("pendingGap")), None)
            if marker is None:
                return False
            records.remove(marker)
            marker["pendingGap"] = False
            counter = self._high_water.get(self.path, 0) + 1
            marker["events"][0]["counter"] = counter
            self._high_water[self.path] = counter
            records.append(marker)
            self._fit_file(self.path, records)
            self._write(self.path, records)
            self._enforce_directory()
            return True

    def next_counter(self):
        with self._locked():
            self._read(self.path)
            return self._high_water.get(self.path, 0) + 1

    def acknowledge(self, through):
        with self._locked():
            records = self._read(self.path)
            for r in records:
                if not r.get("pendingGap"):
                    r["events"] = [e for e in r["events"] if e["counter"] > through]
            self._write(self.path, [r for r in records if r["events"]])

    def quarantine(self):
        with self._locked():
            directory = self.directory / "quarantine"
            directory.mkdir(mode=0o700, exist_ok=True)
            self._safe_directory(directory)
            if self.path.exists():
                os.replace(self.path, directory / self.path.name)
                self._fsync_directory(directory)
                self._fsync_directory(self.directory)
                self._verified.pop(self.path, None)
                self.quarantined += 1
            # Quarantine shares the directory quota with healthy producer histories.
            self._enforce_directory()
