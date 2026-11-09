import asyncio
import logging
import os
import sys
from pathlib import Path

import pytest

from vdoninja.signalserver import serve
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "spec"))
from signaling_contract import assert_signaling
from vdoninja.signalserver import SignalServer

logging.getLogger("vdoninja").setLevel(logging.DEBUG if os.environ.get("VDO_DEBUG") else logging.INFO)


@pytest.fixture
async def signal_host(monkeypatch):
    # Audit before the local server can strip unknown fields; poison incoming
    # `from` to prove the SDK uses the server-assigned UUID in routed mode.
    errors = []
    original_handle, original_send = SignalServer.handle, SignalServer._send

    async def handle(server, uuid, message):
        try:
            assert_signaling(message)
        except AssertionError as error:
            errors.append(str(error))
        await original_handle(server, uuid, message)

    async def send(server, uuid, message):
        if message.get("UUID"):
            message = {**message, "from": "deliberately-wrong-sender"}
        await original_send(server, uuid, message)

    monkeypatch.setattr(SignalServer, "handle", handle)
    monkeypatch.setattr(SignalServer, "_send", send)
    server = await serve("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    yield f"ws://127.0.0.1:{port}"
    server.close()
    await server.wait_closed()
    assert not errors, errors
