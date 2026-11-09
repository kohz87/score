import sqlite3

from score_bridge.session_lineage import session_row


def test_reads_a_row_without_writing(tmp_path):
    path = tmp_path / "state.db"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, source TEXT)")
    db.execute("INSERT INTO sessions VALUES ('tip', 'root', 'api_server')")
    db.commit()
    db.close()
    assert session_row("tip", path) == ("root", "api_server")
    assert session_row("ghost", path) is None


def test_no_database_means_no_row(tmp_path):
    assert session_row("tip", tmp_path / "state.db") is None
