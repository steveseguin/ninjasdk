"""Transparent test proxy: check client messages BEFORE a fixture can rewrite them.

Server replies deliberately contain a conflicting `from`, so SDKs must use the
server-supplied UUID. This tests robustness; it doesn't implement fan-out mode.
"""
import asyncio
import json
import sys
import threading
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from signaling_contract import assert_signaling


class WireAudit:
    def __init__(self, upstream):
        self.upstream = upstream
        self.errors = []
        self.messages = []
        self.ready = threading.Event()

    async def handler(self, client):
        async with websockets.connect(self.upstream) as upstream:
            async def outgoing():
                async for raw in client:
                    try:
                        msg = json.loads(raw)
                        assert_signaling(msg)
                        self.messages.append(msg)
                    except (AssertionError, ValueError) as error:
                        self.errors.append(str(error))
                    await upstream.send(raw)

            async def incoming():
                async for raw in upstream:
                    msg = json.loads(raw)
                    if msg.get("UUID"):
                        msg["from"] = "deliberately-wrong-sender"
                    await client.send(json.dumps(msg))

            tasks = [asyncio.create_task(outgoing()), asyncio.create_task(incoming())]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                results = await asyncio.gather(*tasks, return_exceptions=True)
                for result in results:
                    if isinstance(result, Exception) and not isinstance(result, websockets.exceptions.ConnectionClosed):
                        self.errors.append(repr(result))

    async def run(self):
        self.loop = asyncio.get_running_loop()
        self.stop = asyncio.Event()
        async with websockets.serve(self.handler, "127.0.0.1", 0) as server:
            self.host = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            self.ready.set()
            await self.stop.wait()

    def __enter__(self):
        self.thread = threading.Thread(target=lambda: asyncio.run(self.run()), daemon=True)
        self.thread.start()
        if not self.ready.wait(10):
            raise RuntimeError("Wire audit proxy failed to start")
        return self

    def __exit__(self, *args):
        self.loop.call_soon_threadsafe(self.stop.set)
        self.thread.join(15)
        assert not self.thread.is_alive(), "Wire audit proxy failed to stop"
        assert not self.errors, "Signaling contract violations: " + "; ".join(self.errors)
        assert self.messages, "No signaling was audited"
