import asyncio
import logging
import os

import pytest

from vdoninja.signalserver import serve

logging.getLogger("vdoninja").setLevel(logging.DEBUG if os.environ.get("VDO_DEBUG") else logging.INFO)


@pytest.fixture
async def signal_host():
    server = await serve("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    yield f"ws://127.0.0.1:{port}"
    server.close()
    await server.wait_closed()
