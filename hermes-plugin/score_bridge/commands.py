"""Server -> plugin commands (contract section 11): rewinding a Hermes session, run inside the gateway."""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from urllib.parse import quote

from . import hermes_private
from .client import ProtocolError

_REMEMBERED = 256


def validate_command(item):
    if type(item) is not dict:
        raise ProtocolError("invalid command")
    command_id, session_id, turns = item.get("commandId"), item.get("sessionId"), item.get("turns")
    if type(command_id) is not str or not 0 < len(command_id) <= 128:
        raise ProtocolError("invalid command")
    if item.get("kind") != "rewind" or type(session_id) is not str or not 0 < len(session_id) <= 256:
        raise ProtocolError("invalid command")
    if type(turns) is not int or not 0 < turns <= 1000:
        raise ProtocolError("invalid command")


def run_rewind(item) -> dict:
    """Ask Hermes to rewind; the result body never carries Hermes text, only counts and a fixed error code."""
    try:
        result = hermes_private.rewind_session(item["sessionId"], item["turns"])
    except Exception:
        return {"outcome": "failed", "error": "rewind_failed"}
    if result is None:
        return {"outcome": "nothing"}
    return {"outcome": "done", "turnsUndone": result["turns_undone"], "rewoundCount": result["rewound_count"]}


class CommandPoller:
    """Polls only while this process hosts a gateway; remembers results so a repeated command never rewinds twice."""

    def __init__(self, client):
        self.client = client
        self.stop_event = threading.Event()
        self.thread = None
        self._results: OrderedDict[str, dict] = OrderedDict()

    def start(self):
        if self.thread is None and not self.stop_event.is_set():
            self.thread = threading.Thread(target=self._run, name="score-commands", daemon=True)
            self.thread.start()

    def process_once(self):
        response = self.client.command_request("/bridge/v1/commands?wait=25", None, 28.0)
        if response is None:
            return
        if type(response) is not dict or type(response.get("items")) is not list or len(response["items"]) > 20:
            raise ProtocolError("invalid commands")
        for item in response["items"]:
            validate_command(item)
        for item in response["items"]:
            if self.stop_event.is_set():
                break
            command_id = item["commandId"]
            result = self._results.get(command_id)
            if result is None:
                result = run_rewind(item)
                self._results[command_id] = result
                while len(self._results) > _REMEMBERED:
                    self._results.popitem(last=False)
            path = "/bridge/v1/commands/" + quote(command_id, safe="") + "/result"
            for attempt in range(3):
                if self.stop_event.is_set():
                    break
                try:
                    self.client.command_request(path, result, 5.0)
                    break
                except Exception:
                    if self.stop_event.wait((0.2, 1.0, 0)[attempt]):
                        break

    def _run(self):
        errors = 0
        while not self.stop_event.is_set():
            try:
                if hermes_private.gateway_session_store() is None:
                    # Not inside a gateway (yet): there is no session store to rewind.
                    if self.stop_event.wait(5.0):
                        return
                    continue
                self.process_once()
                errors = 0
            except Exception:
                if self.stop_event.wait((1, 5, 30)[min(errors, 2)]):
                    return
                errors += 1

    def stop(self):
        self.stop_event.set()
        close = getattr(self.client.command_transport, "close", None)
        if callable(close):
            close()

    def join(self, deadline):
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(max(0, deadline - time.monotonic()))
