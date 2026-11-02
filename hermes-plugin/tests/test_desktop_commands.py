"""3.17.0: Bot Desktop takeover commands, run against fake Hermes lease/runtime modules (no Hermes needed)."""
import contextvars
import importlib.util
import sys
import time
import types
from pathlib import Path

import pytest
from score_bridge import hermes_private as stub
from score_bridge.client import ProtocolError
from score_bridge.commands import run_command, validate_command


class FakeLease:
    AGENT, HUMAN = "agent", "human"

    def __init__(self):
        self.state = {"holder": "agent", "viewer_id": None, "reason": "", "epoch": 0}
        self.calls = []

    def _view(self):
        return types.SimpleNamespace(**self.state)

    def get(self, profile_key=None):
        self.calls.append(("get", profile_key))
        return self._view()

    def acquire(self, viewer_id, *, profile_key=None, reason=""):
        self.calls.append(("acquire", viewer_id, profile_key, reason))
        if not (self.state["holder"] == "human" and self.state["viewer_id"] == viewer_id):
            self.state.update(holder="human", viewer_id=viewer_id, reason=reason, epoch=self.state["epoch"] + 1)
        return self._view()

    def release(self, viewer_id=None, *, profile_key=None, epoch=None):
        self.calls.append(("release", viewer_id, profile_key, epoch))
        if epoch is not None and epoch != self.state["epoch"]:
            return self._view()
        if self.state["holder"] == "human" and self.state["viewer_id"] == viewer_id:
            self.state.update(holder="agent", viewer_id=None, reason="", epoch=self.state["epoch"] + 1)
        return self._view()


@pytest.fixture
def hermes(monkeypatch, tmp_path):
    """The real boundary module with fake Hermes modules behind it; the commands are pointed at its functions."""
    override = contextvars.ContextVar("home", default=None)
    constants = types.ModuleType("hermes_constants")
    constants.set_hermes_home_override = lambda path: override.set(str(path))
    constants.reset_hermes_home_override = lambda token: override.reset(token)
    profiles = types.ModuleType("hermes_cli.profiles")
    profiles.get_profile_dir = lambda name: str(tmp_path / "profiles" / name)
    profiles.current_profile_name = lambda: "builder"
    lease = FakeLease()
    touched = []
    runtime = types.ModuleType("tools.bot_desktop.runtime")
    runtime.touch_activity = lambda: touched.append((override.get(), lease.state["epoch"]))
    bot_desktop = types.ModuleType("tools.bot_desktop")
    bot_desktop.lease, bot_desktop.runtime = lease, runtime
    tools = types.ModuleType("tools")
    tools.bot_desktop = bot_desktop
    hermes_cli = types.ModuleType("hermes_cli")
    hermes_cli.profiles = profiles
    for name, module in {"hermes_constants": constants, "hermes_cli": hermes_cli, "hermes_cli.profiles": profiles,
                         "tools": tools, "tools.bot_desktop": bot_desktop,
                         "tools.bot_desktop.runtime": runtime}.items():
        monkeypatch.setitem(sys.modules, name, module)
    path = Path(__file__).parents[1] / "score_bridge/hermes_private.py"
    spec = importlib.util.spec_from_file_location("score_bridge._desktop_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ("desktop_take", "desktop_hand_back", "desktop_touch", "DesktopUnavailable"):
        monkeypatch.setattr(stub, name, getattr(module, name), raising=False)
    return types.SimpleNamespace(lease=lease, touched=touched, override=override,
                                 home=str(tmp_path / "profiles" / "builder"))


def command(kind, **extra):
    return {"commandId": "c1", "kind": kind, "viewerId": "score:abc123def", "expiresAt": time.time() + 30, **extra}


def test_take_stamps_activity_first_in_the_profile_home_and_keeps_the_agents_reason(hermes):
    hermes.lease.state["reason"] = "Please sign in to git.example.com"
    result = run_command(command("desktop_take"), "builder")
    assert result == {"outcome": "done", "lease": {"holder": "human", "viewerId": "score:abc123def", "epoch": 1}}
    # Stamped before the lease changed (epoch still 0), with Hermes' home bound to the profile.
    assert hermes.touched == [(hermes.home, 0)]
    assert ("acquire", "score:abc123def", hermes.home, "Please sign in to git.example.com") in hermes.lease.calls
    assert hermes.override.get() is None  # the binding is undone afterwards


def test_hand_back_passes_its_own_viewer_and_epoch_so_a_later_takeover_is_kept(hermes):
    run_command(command("desktop_take"), "builder")
    hermes.lease.state.update(viewer_id="hermes-app", epoch=2)  # the Hermes app took over since
    result = run_command(command("desktop_hand_back", epoch=1), "builder")
    assert result["lease"] == {"holder": "human", "viewerId": "hermes-app", "epoch": 2}
    assert ("release", "score:abc123def", hermes.home, 1) in hermes.lease.calls
    hermes.lease.state.update(viewer_id="score:abc123def", epoch=1)
    assert run_command(command("desktop_hand_back", epoch=1), "builder")["lease"]["holder"] == "agent"


def test_touch_stamps_only_while_this_viewer_holds_the_desktop(hermes):
    run_command(command("desktop_touch"), "builder")
    assert hermes.touched == []
    run_command(command("desktop_take"), "builder")
    run_command(command("desktop_touch"), "builder")
    assert len(hermes.touched) == 2


def test_no_lease_api_is_a_fixed_error(hermes, monkeypatch):
    monkeypatch.setitem(sys.modules, "tools.bot_desktop", types.ModuleType("tools.bot_desktop"))
    path = Path(__file__).parents[1] / "score_bridge/hermes_private.py"
    spec = importlib.util.spec_from_file_location("score_bridge._desktop_test2", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(stub, "desktop_take", module.desktop_take, raising=False)
    monkeypatch.setattr(stub, "DesktopUnavailable", module.DesktopUnavailable, raising=False)
    assert run_command(command("desktop_take"), "builder") == {"outcome": "failed", "error": "desktop_unavailable"}


@pytest.mark.parametrize("item", [
    command("desktop_take", viewerId="hermes-app"),
    command("desktop_take", viewerId="score:"),
    command("desktop_take", reason="x" * 501),
    command("desktop_hand_back"),
    command("desktop_hand_back", epoch=-1),
    command("desktop_hand_back", epoch="1"),
])
def test_invalid_desktop_commands_are_refused(item):
    with pytest.raises(ProtocolError):
        validate_command(item)


def test_valid_desktop_commands_need_no_session():
    validate_command(command("desktop_take"))
    validate_command(command("desktop_hand_back", epoch=3))
    validate_command(command("desktop_touch"))
