"""Registration collision regressions for the bundled signaling server."""
import asyncio
import json

import websockets
from vdoninja.signalserver import SignalServer


async def test_leave_is_not_a_server_command():
    server = SignalServer()
    server.rooms["peer"] = "room"
    server.room_list["room"] = ["peer"]
    server.directors["room"] = "peer"
    await server.handle("peer", {"leave": True})
    assert server.rooms["peer"] == "room"
    assert server.directors["room"] == "peer"
    server.cleanup("peer")
    assert not server.rooms and not server.room_list and not server.directors


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


async def test_seed_wakes_only_same_room_waiters():
    class Socket:
        def __init__(self):
            self.messages = []

        async def send(self, text):
            self.messages.append(json.loads(text))

    server = SignalServer()
    for uuid in ("publisher", "viewer", "outside"):
        server.clients[uuid] = Socket()
    await server.join_room("publisher", "room", False, "")
    await server.join_room("viewer", "room", False, "")
    await server.join_room("outside", "other", False, "")
    await server.play("viewer", "future")
    await server.play("outside", "future")
    await server.seed("publisher", "future")
    offers = [m for m in server.clients["publisher"].messages if m["request"] == "offerSDP"]
    assert offers == [{"request": "offerSDP", "UUID": "viewer"}]
    assert server.waiting["future"] == {"outside"}
