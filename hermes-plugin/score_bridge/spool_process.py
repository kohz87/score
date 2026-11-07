"""Producer process identity for the spool."""
from __future__ import annotations

from pathlib import Path


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
