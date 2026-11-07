import pytest

from score_bridge.client import ScoreClient
from score_bridge.sender import Sender
from score_bridge.spool import Spool
from helpers import FakeTransport


@pytest.fixture
def setup(tmp_path):
    token = tmp_path / "token"
    token.write_text("bootstrap")
    transport = FakeTransport()
    client = ScoreClient(token_path=token, transport=transport)
    sender = Sender(client, Spool(client.incarnation, tmp_path / "spool"))
    yield sender, transport
    sender.shutdown(0.1)
