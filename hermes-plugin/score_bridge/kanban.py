"""Bounded, fail-open capture of verified unattended terminal denials."""
from __future__ import annotations

import json
import os

from . import hermes_private
from .redact import digest


def capture_denial(raw):
    try:
        task = os.environ.get("HERMES_KANBAN_TASK")
        if not task or len(task) > 256 or raw.get("tool_name") != "terminal":
            return None
        result = raw.get("result")
        args = raw.get("args")
        command = args.get("command") if type(args) is dict else None
        if (type(result) is not str or len(result) > 16_384
                or len(result.encode("utf-8")) > 16_384
                or type(command) is not str or len(command) > 16_384):
            return None
        decoded = json.loads(result)
        if (type(decoded) is not dict or decoded.get("status") != "blocked"
                or type(decoded.get("error")) is not str
                or not decoded["error"].startswith("BLOCKED: Command flagged as dangerous")):
            return None
        pattern = hermes_private.detect_dangerous(command)
        if pattern is None:
            return None
        run = os.environ.get("HERMES_KANBAN_RUN_ID", "")
        try:
            run_id = int(run) if len(run) <= 16 else None
            if run_id is not None and not 0 <= run_id <= 9_007_199_254_740_991:
                run_id = None
        except ValueError:
            run_id = None
        return {"patternKey": pattern, "commandDigest": digest(command), "taskId": task, "runId": run_id}
    except Exception:
        return None
