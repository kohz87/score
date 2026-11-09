"""Where a session came from, read from the profile's own state.db (read-only; never the network).

Hermes gives a session a new generated id when it compresses, so an id alone says nothing about whose it is. Each row names
its parent, and a compression child keeps its parent's source, so a subagent stays a subagent.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

# <profile home>/plugins/score-bridge/session_lineage.py
_STATE_DB = Path(__file__).resolve().parents[2] / "state.db"


def session_row(session_id: str, path: Path = _STATE_DB) -> tuple[str | None, str | None] | None:
    """(parent id, source), or None for a session this profile has no row for yet."""
    if not path.exists():
        return None
    db = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=1)
    try:
        return db.execute("SELECT parent_session_id, source FROM sessions WHERE id = ?", (session_id,)).fetchone()
    finally:
        db.close()
