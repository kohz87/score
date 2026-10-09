"""Fail-open Hermes plugin: hooks capture bounded snapshots for a daemon sender."""
from __future__ import annotations

import atexit
import os

HOOKS = (
    "pre_tool_call", "post_tool_call", "pre_approval_request", "post_approval_response",
    "on_session_start", "on_session_end", "on_interim_message", "subagent_start", "subagent_stop",
    "on_human_input_request", "on_human_input_resolved", "on_kanban_worker_spawned",
    "on_kanban_worker_exited", "on_kanban_task_updated",
)
_sender = None
_pid = None
_exit_callback = None


def _current_sender():
    if _sender is not None and _sender._lazy_start:
        _sender.start()
    return _sender


def _make_hook(hook):
    def wrapper(*args, **kwargs):
        current = None
        try:
            current = _current_sender()
            if current is not None:
                current.enqueue(hook, args, kwargs)
        except Exception:
            if current is not None:
                try:
                    current.record_error("hook:" + hook)
                except Exception:
                    pass
        return None
    return wrapper


def _reset_after_fork():
    global _sender, _pid, _exit_callback
    from .client import ScoreClient
    from .gates import reset
    reset()
    from .sender import Sender
    from .spool import close_inherited_descriptors
    close_inherited_descriptors()
    old = _sender
    if old is not None:
        for client, _ in old._producers.values():
            reset_transport = getattr(client.decision_transport, "after_fork", None)
            if callable(reset_transport):
                reset_transport()
    if old is None or old._closed:
        _sender = None
        return
    if _exit_callback is not None:
        atexit.unregister(_exit_callback)
    client = ScoreClient(old.client.base_url, old.client.token_path, old.client.transport,
                         clock=old.client.clock, profile=old.client.profile)
    _sender = Sender(client, old.spool, capacity=old.queue.maxsize)
    _sender._lazy_start = True
    _pid = os.getpid()
    _exit_callback = _sender.shutdown
    atexit.register(_exit_callback)


def _register_knowledge(ctx):
    try:
        from .knowledge import register_tools
        register_tools(ctx)
    except Exception:
        pass


def register(ctx):
    global _sender, _pid, _exit_callback
    _register_knowledge(ctx)
    try:
        from .client import ScoreClient
        from .gates import reset
        reset()
        from .sender import Sender
        if _sender is not None:
            _sender.shutdown()
        if _exit_callback is not None:
            atexit.unregister(_exit_callback)
        _sender = Sender(ScoreClient())
        _sender.start()
        _pid = os.getpid()
        _exit_callback = _sender.shutdown
        atexit.register(_exit_callback)
        sender, callback, pid = _sender, _exit_callback, _pid
        def unload():
            global _sender, _exit_callback
            target = sender if os.getpid() == pid else _sender
            cleanup = callback if os.getpid() == pid else _exit_callback
            if target is not None:
                target.shutdown()
            if cleanup is not None:
                atexit.unregister(cleanup)
            if _sender is target:
                _sender = None
                _exit_callback = None
        on_unload = getattr(ctx, "on_unload", None)
        if callable(on_unload):
            on_unload(unload)
        for hook in HOOKS:
            try:
                ctx.register_hook(hook, _make_hook(hook))
            except Exception:
                sender.record_error("register:" + hook)
    except Exception:
        return None


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_after_fork)
