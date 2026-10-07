"""Bounded capture queue and independent, profile-scoped producer outboxes."""
from __future__ import annotations

import contextvars
import json
import queue
import re
import threading
import time
from collections import deque
from datetime import datetime, timezone
from urllib.error import HTTPError

from . import hermes_private
from .gates import capture
from .client import ScoreClient
from .redact import bound_payload, digest, scrub, snapshot
from .spool import Spool, gap_event


def merge_ranges(ranges, first, last, at):
    ranges.append((first, last, at))
    ranges.sort(key=lambda r: r[0])
    merged = []
    for start, end, stamp in ranges:
        if merged and start <= merged[-1][1] + 1:
            old, previous, _ = merged[-1]
            merged[-1] = (old, max(previous, end), stamp)
        else:
            merged.append((start, end, stamp))
    if len(merged) > 100:
        merged = merged[:99] + [(merged[99][0], merged[-1][1], merged[-1][2])]
    ranges[:] = merged


class HookQueue(queue.Queue):
    def __init__(self, sender, capacity):
        super().__init__(maxsize=capacity)
        self.sender = sender

    def put_nowait(self, item):
        sender = self.sender
        if not self.mutex.acquire(timeout=0.002):
            sender.contended += 1
            sender._contention.append(item["profile"])
            return
        try:
            if sender._closed:
                sender.dropped += 1
                return
            profile = item["profile"]
            sender._observed[profile] = sender._observed.get(profile, 0) + 1
            item["observation"] = sender._observed[profile]
            if self._qsize() >= self.maxsize:
                old = self._get()
                sender.dropped += 1
                sender._loss(old["profile"], old["observation"], old["observation"], old["at"])
            self._put(item)
            self.not_empty.notify()
            ready = self._qsize() >= 100
        finally:
            self.mutex.release()
        if ready:
            sender._wake.set()


class Sender:
    def __init__(self, client, spool=None, *, capacity=10_000):
        if capacity < 1:
            raise ValueError("queue capacity must be positive")
        self.process_incarnation = client.incarnation
        profile = client.profile or hermes_private.current_profile()
        client.profile = profile
        client.incarnation = self._incarnation(profile)
        self.client = client
        self.spool = Spool(client.incarnation, spool.directory if spool else None,
                           file_cap=spool.file_cap if spool else 5 * 1024 * 1024,
                           directory_cap=spool.directory_cap if spool else 50 * 1024 * 1024)
        self._producers = {profile: (client, self.spool)}
        self._counters = {profile: 0}
        self.queue = HookQueue(self, capacity)
        self.errors = deque(maxlen=100)
        self.counter = self.dropped = self.contended = self.quarantined = 0
        self._gaps = {}
        self._observed = {}
        # Contention reporting cannot acquire the contended admission lock.
        self._contention = deque(maxlen=10_000)
        self._reported_contention = 0
        self._orphan_backoff = {}
        self._wake, self._stop = threading.Event(), threading.Event()
        self._thread = None
        self._lazy_start = False
        self._start_lock = threading.Lock()
        self._cycle_lock = threading.Lock()
        self._persist_lock = threading.Lock()
        self._closed = False

    def _incarnation(self, profile):
        suffix = profile if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", profile) else digest(profile)
        return self.process_incarnation + "-" + suffix

    def _producer(self, profile):
        if profile not in self._producers:
            client = ScoreClient(self.client.base_url, self.client.token_path,
                                 self.client.transport, clock=self.client.clock, profile=profile)
            client.incarnation = self._incarnation(profile)
            spool = Spool(client.incarnation, self.spool.directory,
                          file_cap=self.spool.file_cap, directory_cap=self.spool.directory_cap)
            self._producers[profile] = (client, spool)
        return self._producers[profile]

    def record_error(self, where):
        self.errors.append(where)

    def _loss(self, profile, first, last, at):
        merge_ranges(self._gaps.setdefault(profile, []), first, last, at)

    def enqueue(self, hook, args, kwargs):
        at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if args:
            # Apply one shared node budget to args and kwargs together.
            payload = snapshot({"kwargs": kwargs, "positional_args": args})
            named = payload.get("kwargs", {})
            payload = {**named, "positional_args": payload.get("positional_args", "[omitted]")}
        else:
            payload = snapshot(kwargs)
        command = payload.get("command")
        if type(command) is not str and type(payload.get("args")) is dict:
            command = payload["args"].get("command")
        command_digest = digest(command) if type(command) is str and not command.startswith("[omitted:") else None
        payload = capture(hook, payload, command_digest)
        self.queue.put_nowait({"hook": hook, "at": at, "raw": payload, "digest": command_digest,
                               "profile": hermes_private.current_profile(), "context": contextvars.copy_context()})

    def _take(self, deadline=None):
        if not self.queue.mutex.acquire(timeout=max(0, deadline - time.monotonic()) if deadline else 0.002):
            return []
        try:
            now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            # Any records beyond the bounded contention ledger become a summary loss.
            outstanding = self.contended - self._reported_contention
            profiles = []
            for _ in range(min(len(self._contention), outstanding)):
                profiles.append(self._contention.popleft())
            counts = {}
            for profile in profiles:
                counts[profile] = counts.get(profile, 0) + 1
            if outstanding > len(profiles):
                counts[self.client.profile] = counts.get(self.client.profile, 0) + outstanding - len(profiles)
            for profile, count in counts.items():
                first = self._observed.get(profile, 0) + 1
                self._observed[profile] = first + count - 1
                self._loss(profile, first, first + count - 1, now)
            self._reported_contention += outstanding
            records = []
            # Reserve the first slot for a loss report even under a full queue.
            for profile, ranges in self._gaps.items():
                if ranges and len(records) < 200:
                    count = sum(last - first + 1 for first, last, _ in ranges)
                    first = self._counters.get(profile, 0) + 1
                    marker = gap_event(first, first + count - 1, ranges[-1][2])
                    marker["profile"] = profile
                    self._counters[profile] = first + count
                    marker["counter"] = first + count
                    records.append(marker)
                    ranges.clear()
            while self.queue._qsize() and len(records) < 200:
                record = self.queue._get()
                profile = record["profile"]
                self._counters[profile] = self._counters.get(profile, 0) + 1
                record["counter"] = self._counters[profile]
                records.append(record)
            self.counter = self._counters.get(self.client.profile, 0)
            return records
        finally:
            self.queue.mutex.release()

    def _build(self, raw):
        if "raw" not in raw:
            return {key: value for key, value in raw.items() if key != "profile"}
        safe = raw["context"].run(scrub, raw["raw"], hermes_private.redact)
        if raw["digest"]:
            safe["command_digest"] = raw["digest"]
        safe = bound_payload(safe)
        def lifted(snake, camel):
            value = safe.get(snake, safe.get(camel))
            return value if type(value) is str and value else None
        return {"counter": raw["counter"], "hook": raw["hook"], "at": raw["at"],
                "sessionKey": lifted("session_key", "sessionKey"), "sessionId": lifted("session_id", "sessionId"),
                "toolCallId": lifted("tool_call_id", "toolCallId"), "payload": safe}

    def _persist(self, deadline=None):
        if not self._persist_lock.acquire(timeout=max(0, deadline - time.monotonic()) if deadline else 0.002):
            return False
        try:
            for profile, (_, spool) in list(self._producers.items()):
                spool.deadline = deadline
                try:
                    spool.materialize_gap()
                    self._counters[profile] = max(self._counters.get(profile, 0), spool.next_counter() - 1)
                except Exception:
                    self.record_error("spool")
                finally:
                    spool.deadline = None
            records = self._take(deadline)
            if not records:
                return False
            groups = {}
            for raw in records:
                groups.setdefault(raw["profile"], []).append(raw)
            success = True
            for profile, items in groups.items():
                client, spool = self._producer(profile)
                spool.deadline = deadline
                events = []
                try:
                    for raw in items:
                        if deadline and time.monotonic() >= deadline:
                            raise TimeoutError()
                        try:
                            events.append(self._build(raw))
                        except Exception:
                            self.record_error("payload")
                            events.append(gap_event(raw["counter"], raw["counter"], raw["at"]))
                    spool.producer = client.identity()
                    spool.append(events)
                except Exception:
                    self.record_error("spool")
                    success = False
                    self.dropped += sum("raw" in raw for raw in items)
                    if not deadline:
                        # Durable retry metadata is bounded just like capture losses.
                        with self.queue.mutex:
                            self._loss(profile, items[0]["counter"], items[-1]["counter"], items[-1]["at"])
                finally:
                    spool.deadline = None
            return success
        finally:
            self._persist_lock.release()

    def _drain(self, spool=None, client=None, *, limit=None):
        spool, client = spool or self.spool, client or self.client
        batches = 0
        while not self._stop.is_set():
            # Materialize losses regardless of queue depth, before admitting new batches.
            if self._persist_lock.acquire(timeout=0.002):
                try:
                    spool.materialize_gap()
                    if self._producers.get(client.profile, (None, None))[0] is client:
                        self._counters[client.profile] = max(self._counters.get(client.profile, 0),
                                                            spool.next_counter() - 1)
                finally:
                    self._persist_lock.release()
            events = spool.peek()
            if not events:
                return True
            # Use the HTTP encoder, including the envelope and its default escaping/separators.
            # Encode each event once: the body is '{"events": [' + items joined by ", " + ']}'.
            prefix, size = [], len(b'{"events": []}')
            for event in events[:200]:
                size += len(json.dumps(event, allow_nan=False).encode("utf-8")) + (2 if prefix else 0)
                if size > 1.5 * 1024 * 1024:
                    break
                prefix.append(event)
            if not prefix:
                raise ValueError("event exceeds request budget")
            events = prefix
            ack = client.send(events)
            if ack < events[0]["counter"]:
                return False
            spool.acknowledge(min(ack, events[-1]["counter"]))
            batches += 1
            if limit is not None and batches >= limit:
                return True
        return False

    def _recover_orphans(self):
        try:
            identities = self.spool.recoverable()
        except Exception:
            self.record_error("recover")
            return
        for identity in identities:
            incarnation = identity["incarnation"]
            next_try, attempts = self._orphan_backoff.get(incarnation, (0, 0))
            if time.monotonic() < next_try:
                continue
            recovered = self.client.recover(identity)
            spool = Spool(incarnation, self.spool.directory,
                          file_cap=self.spool.file_cap, directory_cap=self.spool.directory_cap)
            try:
                if not self._drain(spool, recovered, limit=1):
                    raise ConnectionError()
                self._orphan_backoff.pop(incarnation, None)
            except Exception as exc:
                self.record_error("orphan")
                if isinstance(exc, HTTPError) and exc.code in (401, 403, 404):
                    try:
                        spool.quarantine()
                        self.quarantined += 1
                    except Exception:
                        self.record_error("quarantine")
                self._orphan_backoff[incarnation] = (time.monotonic() + min(60, 2 ** min(attempts, 6)), attempts + 1)

    def process_once(self):
        with self._cycle_lock:
            online = {}
            for profile, (client, spool) in list(self._producers.items()):
                try:
                    online[profile] = self._drain(spool, client)
                except Exception:
                    self.record_error("send")
                    online[profile] = False
            while self._persist():
                for profile, (client, spool) in list(self._producers.items()):
                    if online.get(profile, True):
                        try:
                            online[profile] = self._drain(spool, client)
                        except Exception:
                            self.record_error("send")
                            online[profile] = False
                if self._stop.is_set():
                    break
            if not self._stop.is_set():
                self._recover_orphans()

    def start(self):
        if self._thread is not None or self._closed:
            return
        if not self._start_lock.acquire(timeout=0.002):
            return
        try:
            if self._thread is None and not self._closed:
                self._thread = threading.Thread(target=self._run, name="score-bridge", daemon=True)
                self._thread.start()
        finally:
            self._start_lock.release()

    def _run(self):
        while not self._stop.is_set():
            self._wake.wait(0.25)
            self._wake.clear()
            try:
                self.process_once()
            except (KeyboardInterrupt, SystemExit):
                self._stop.set()
                return
            except Exception:
                self.record_error("sender")

    def shutdown(self, budget=2.0):
        deadline = time.monotonic() + budget
        self._closed = True
        self._stop.set()
        self._wake.set()
        # No network or new threads at exit. Persistence has its own bounded locks.
        try:
            while time.monotonic() < deadline and self._persist(deadline):
                pass
        except Exception:
            self.record_error("shutdown")
        if self.queue.mutex.acquire(timeout=max(0, deadline - time.monotonic())):
            try:
                self.dropped += self.queue._qsize()
                self.queue.queue.clear()
            finally:
                self.queue.mutex.release()
        else:
            self.dropped += len(self.queue.queue)
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(max(0, deadline - time.monotonic()))
