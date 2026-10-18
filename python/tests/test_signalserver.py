"""Registration collision regressions for the bundled signaling server."""
import asyncio
import json

import websockets


async def test_join_room_cannot_steal_stream(signal_host):
    async with websockets.connect(signal_host) as owner, websockets.connect(signal_host) as other:
        async def send(ws, **message):
            await ws.send(json.dumps(message))

        async def read(ws):
            return json.loads(await asyncio.wait_for(ws.recv(), 3))

        await send(owner, request="seed", streamID="taken")
        await send(owner, request="joinroom", roomid="room")
        assert (await read(owner))["request"] == "listing"
        await send(other, request="seed", streamID="taken")
        await send(other, request="joinroom", roomid="room", streamID="taken", claim=True)
        assert (await read(other))["request"] == "alert"
        assert (await read(other))["request"] == "alert"
        await send(other, request="joinroom", roomid="room")
        listing = await read(other)
        assert listing["request"] == "listing"
        assert "director" not in listing
        assert listing["list"][0]["streamID"] == "taken"
        assert (await read(owner))["request"] == "someonejoined"
        await send(other, request="play", streamID="taken")
        assert (await read(owner))["request"] == "offerSDP"
