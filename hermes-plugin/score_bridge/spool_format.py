"""Envelope encoding, loss markers and durable-record validation for the spool."""
from __future__ import annotations

import json
from datetime import datetime

FILE_CAP = 5 * 1024 * 1024
DIRECTORY_CAP = 50 * 1024 * 1024


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
