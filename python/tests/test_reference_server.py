"""Optional check against an unmodified VDO.Ninja hss/gemini.js process.

Start that server separately, then set VDONINJA_REFERENCE_HOST=ws://127.0.0.1:8443.
The normal suite skips this test; it does not substitute the SDK's bundled server.
"""
import asyncio
import json
import os
import uuid

import pytest
import websockets

from vdoninja import VDONinja


@pytest.mark.skipif(not os.environ.get("VDONINJA_REFERENCE_HOST"), reason="reference server not configured")
async def test_reference_room_leave(monkeypatch):
    host = os.environ["VDONINJA_REFERENCE_HOST"]
    sdk = VDONinja(host, turn=False, stun_servers=[])
    sent = []
    send = sdk._send_ws

    def capture(message):
        sent.append(dict(message))
        return send(message)

    monkeypatch.setattr(sdk, "_send_ws", capture)
    try:
        await sdk.connect()
        await sdk.join_room("spec" + uuid.uuid4().hex[:16], claim=True)
        join = sent[0]
        assert set(join) == {"request", "roomid", "claim"}
        await sdk.leave_room()
        assert not sdk.connected
        assert sent == [join], "leave emitted a non-native signaling message"

        # A fresh socket must be able to claim the same room immediately. If
        # leave only clears local state, the reference server retains its owner.
        async with websockets.connect(host) as peer:
            await peer.send(json.dumps(join))
            listing = json.loads(await asyncio.wait_for(peer.recv(), 5))
            assert listing["request"] == "listing"
            assert listing["claim"] is True
            assert listing["list"] == []

        await sdk.connect()
        await sdk.join_room("spec" + uuid.uuid4().hex[:16])
        assert sdk.room_joined
    finally:
        await sdk.disconnect()
