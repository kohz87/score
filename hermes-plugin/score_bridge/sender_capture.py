"""Bounded, fail-closed hook payload preparation for the sender."""
from __future__ import annotations

import json
import re

from .redact import digest, sensitive_tool, tail_source, touches_credential_file


_SCREENSHOT_NAME = re.compile(r"browser_screenshot_[0-9a-f]+\.png")


def _screenshot_watch(result):
    """Only the path of a browser_vision screenshot leaves the process; the server validates and reads the file."""
    if type(result) is str and len(result) <= 1_000_000 and result.lstrip()[:1] == "{":
        try:
            result = json.loads(result)
        except ValueError:
            return None
    if type(result) is not dict:
        return None
    meta = result.get("meta")
    path = result.get("screenshot_path")
    if path is None and type(meta) is dict:
        path = meta.get("screenshot_path")
    if type(path) is not str or not 0 < len(path) <= 4096 or "\0" in path:
        return None
    if not _SCREENSHOT_NAME.fullmatch(path.replace("\\", "/").rsplit("/", 1)[-1]):
        return None
    return {"screenshot_path": path}


def _watch_capture(hook, kwargs, args):
    """Tool-hook inputs for Watch: (kwargs, args, raw terminal capture or None).

    Credential-bearing tools lose their arguments and results here, before anything is snapshotted. File tools that
    touch a credential file lose their content. Terminal and code output is kept as a tail (see redact.tail_source);
    it stays raw until the sender thread redacts it, like every other payload.
    """
    try:
        name = kwargs.get("tool_name")
        if sensitive_tool(name):
            return ({key: value for key, value in kwargs.items()
                     if key not in ("args", "result", "command", "error_message")}, (), None)
        tool_args = kwargs.get("args")
        # Reads too: a credential file's content comes back in the result, and errors can echo it.
        if touches_credential_file(tool_args):
            kept = {key: value for key, value in kwargs.items() if key not in ("result", "error_message")}
            kept["args"] = {key: value for key, value in tool_args.items()
                            if key not in ("content", "patch", "old_string", "new_string")}
            return kept, args, None
        if hook == "post_tool_call" and name == "browser_vision":
            return kwargs, args, _screenshot_watch(kwargs.get("result"))
        if hook != "post_tool_call" or name not in ("terminal", "execute_code"):
            return kwargs, args, None
        result = kwargs.get("result")
        if type(result) is str and len(result) <= 1_000_000 and result.lstrip()[:1] == "{":
            try:
                result = json.loads(result)
            except ValueError:
                return kwargs, args, None
        if type(result) is not dict:
            return kwargs, args, None
        source = tail_source(result.get("output"))
        watch = {}
        if source is not None:
            watch["raw_output"], watch["full_length"] = source
        code = result.get("exit_code")
        if type(code) is int and type(code) is not bool:
            watch["exit_code"] = code
        cwd = result.get("cwd") or (tool_args.get("workdir") if type(tool_args) is dict else None)
        if type(cwd) is str and len(cwd) <= 4096:
            watch["cwd"] = cwd
        return kwargs, args, watch or None
    except Exception:
        # Fail closed: if the checks above could not run, the arguments and result are not sent at all.
        return ({key: value for key, value in kwargs.items()
                 if key not in ("args", "result", "command", "error_message")}, (), None)


def _args_digest(kwargs):
    """sha256 of the call's arguments as canonical JSON (sorted keys, no spaces, UTF-8), or None when they aren't JSON."""
    args = kwargs.get("args") if isinstance(kwargs, dict) else None
    if not isinstance(args, dict):
        return None
    try:
        text = json.dumps(args, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    except Exception:
        # Not plain JSON (or too deep): no digest, and the hook path goes on.
        return None
    # Bounded work on the hook thread: arguments past 1 MB get no digest (a report-back is never that large).
    return digest(text) if len(text) <= 1_000_000 else None
