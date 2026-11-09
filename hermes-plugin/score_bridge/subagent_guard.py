"""Keeps subagents inside their limits and out of the room (docs/briefs/SA-subagents.md).

Hermes makes ``pre_tool_call`` fail closed: a slow hook blocks the tool, then that callback is suppressed for a minute. So
this never touches the network. Limits come from a small file Score writes per session, read at the call, so a change
applies to the next call. Any tool that isn't ``delegate_task`` or one of Score's returns at once, and only those two
kinds can ever be blocked. Unlike the plugin's observer hooks, which fail open, this is a limit: if it can't decide, it
refuses.

It stops ordinary tool use, not a determined script: a subagent with a terminal can do what its parent's terminal can.
"""
from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from pathlib import Path

from .client import score_home

SCORE_TOOL_PREFIXES = ("score_", "knowledge_", "mcp_score_", "mcp__score__")
# The sessions Score names itself (domain/job-sessions.ts, the orchestration executor). A room continuing an outside
# session has another name, but Score writes its policy before the run, so the file is what counts there.
SCORE_SESSION_PREFIXES = ("score-", "orc-")
LIVE_CONTROL_ACTIONS = frozenset({"list", "steer", "stop"})
MAX_TRACKED_SESSIONS = 4096
MAX_POLICY_BYTES = 4096

ROOM_TOOL_REFUSED = "Score: a subagent can't use Score's tools. Report to your parent instead."
NO_POLICY = "Score: this session has no subagent limit Score can read, so subagents are off. Do the work yourself."
UNDECIDED = "Score couldn't check this call, so it was refused."
BACKGROUND = (
    "Score: this chat started before subagents were set up for this agent, so they are off here. "
    "Do the work yourself, or ask for a new job."
)
OFF = "Score: subagents are off for this job. Do the work yourself."


def policy_path(home: Path, session_id: str) -> Path:
    """The same name the server uses (hermes/live/subagent-policy.ts): a session id is not a safe file name."""
    return home / "subagents" / (hashlib.sha256(session_id.encode()).hexdigest() + ".json")


def _block(message: str) -> dict:
    return {"action": "block", "message": message}


def _whole(value) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _task_count(args) -> int:
    tasks = args.get("tasks") if isinstance(args, dict) else None
    # The handler also accepts the legacy single-goal shape, which is one task.
    return len(tasks) if isinstance(tasks, list) and tasks else 1


class SubagentGuard:
    def __init__(self, home: Path | None = None):
        self._home = home
        self._lock = threading.Lock()
        self._children: OrderedDict[str, None] = OrderedDict()
        self._started: OrderedDict[str, int] = OrderedDict()

    def on_subagent_start(self, child_session_id=None, **_kwargs) -> None:
        """Hermes runs this on the parent's thread before the child starts, so a child's first call is already known."""
        if isinstance(child_session_id, str) and child_session_id:
            with self._lock:
                self._remember(self._children, child_session_id, None)

    def pre_tool_call(self, tool_name=None, args=None, session_id="", **_kwargs):
        name = tool_name if isinstance(tool_name, str) else ""
        delegating = name == "delegate_task"
        if not delegating and not name.startswith(SCORE_TOOL_PREFIXES):
            return None
        try:
            return self._decide(name, delegating, args, session_id if isinstance(session_id, str) else "")
        except Exception:
            return _block(UNDECIDED)

    def _decide(self, name: str, delegating: bool, args, session_id: str):
        with self._lock:
            child = session_id in self._children
        if child:
            return _block(ROOM_TOOL_REFUSED)
        if not delegating:
            return None
        if isinstance(args, dict) and args.get("action") in LIVE_CONTROL_ACTIONS:
            return None
        policy = self._read_policy(session_id)
        if policy is None:
            return _block(NO_POLICY) if session_id.startswith(SCORE_SESSION_PREFIXES) else None
        return self._within_limits(session_id, policy, _task_count(args))

    def _read_policy(self, session_id: str) -> dict | None:
        """None: no file. A file that can't be read or parsed raises, and the caller refuses."""
        if not session_id:
            return None
        path = policy_path(self._home or score_home(), session_id)
        try:
            with open(path, "rb") as handle:
                raw = handle.read(MAX_POLICY_BYTES + 1)
        except FileNotFoundError:
            return None
        if len(raw) > MAX_POLICY_BYTES:
            raise ValueError("oversized policy")
        policy = json.loads(raw)
        if not isinstance(policy, dict) or policy.get("v") != 1:
            raise ValueError("unknown policy")
        return policy

    def _within_limits(self, session_id: str, policy: dict, asked: int):
        if policy.get("inline") is not True:
            return _block(BACKGROUND)
        if policy.get("enabled") is not True:
            return _block(OFF)
        at_once = _whole(policy.get("maxConcurrent"))
        total = _whole(policy.get("maxTotal"))
        used = _whole(policy.get("used"))
        if at_once is None or total is None or used is None:
            raise ValueError("invalid policy")
        if asked > at_once:
            return _block(
                f"Score: the limit is {at_once} subagent{'' if at_once == 1 else 's'} at once in this job; "
                f"you asked for {asked}. Ask for fewer."
            )
        with self._lock:
            # Score's count lags and this one starts again after a restart, so the larger is the truth.
            so_far = max(used, self._started.get(session_id, 0))
            if so_far + asked > total:
                return _block(
                    f"Score: this job has used {so_far} of its {total} subagents, so {asked} more won't fit. "
                    "Finish the work yourself."
                )
            self._remember(self._started, session_id, so_far + asked)
        return None

    @staticmethod
    def _remember(table: OrderedDict, key: str, value) -> None:
        table[key] = value
        table.move_to_end(key)
        while len(table) > MAX_TRACKED_SESSIONS:
            table.popitem(last=False)
