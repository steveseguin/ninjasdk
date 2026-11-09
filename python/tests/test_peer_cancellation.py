import asyncio

import pytest
from vdoninja import VDONinja
from vdoninja.sdk import VDONinjaError
from aiortc import RTCSessionDescription


@pytest.mark.parametrize("kind", ["publisher", "viewer"])
@pytest.mark.parametrize("reconnect", [False, True])
async def test_disconnect_cancels_peer_waiting_for_discovery(signal_host, kind, reconnect):
    sdk = VDONinja(signal_host, turn=False, stun_servers=[])
    entered, release = asyncio.Event(), asyncio.Event()

    async def discovery():
        entered.set()
        await release.wait()
        return []

    sdk._ice_servers = discovery
    await sdk.connect()
    pending = asyncio.create_task(sdk._create_connection("old-peer", kind))
    try:
        await entered.wait()
        await sdk.disconnect()


        if reconnect:
            await sdk.connect()
        release.set()
        with pytest.raises(VDONinjaError, match="cancelled"):
            await pending
        assert not sdk.connections
        assert not sdk._queue
        if reconnect:
            current = await sdk._create_connection("current-peer", kind)
            assert sdk._is_current(current)
    finally:
        release.set()
        await asyncio.gather(pending, return_exceptions=True)
        await sdk.disconnect()


async def test_repeated_disconnect_does_not_send_old_sdp(signal_host):
    sdk = VDONinja(signal_host, turn=False, stun_servers=[])
    async def discovery():
        return []
    sdk._ice_servers = discovery
    sent = []
    try:
        for attempt in range(12):
            await sdk.connect()
            old = await sdk._create_connection(f"peer-{attempt}", "publisher")
            await sdk.disconnect()
            await sdk.connect()
            sdk._send_ws = lambda message: sent.append(message)
            sdk._send_description(old, RTCSessionDescription(sdp="v=0\r\n", type="offer"), False)
            assert not sent
            assert not sdk.connections
            await sdk.disconnect()
    finally:
        await sdk.disconnect()


async def test_disconnect_during_peer_replacement_does_not_start_a_timer():
    sdk = VDONinja(turn=False, stun_servers=[])
    async def discovery():
        return []
    sdk._ice_servers = discovery
    old = await sdk._create_connection("peer", "publisher")
    entered, release = asyncio.Event(), asyncio.Event()
    close = old.close
    async def delayed_close():
        entered.set()
        await release.wait()
        await close()
    old.close = delayed_close
    pending = asyncio.create_task(sdk._create_connection("peer", "publisher"))
    try:
        await entered.wait()
        replacement = sdk.connections["peer"].publisher
        await sdk.disconnect()
        release.set()
        with pytest.raises(VDONinjaError, match="cancelled"):
            await pending
        assert replacement.pc.connectionState == "closed"
        assert replacement.connect_task is None
        assert not sdk.connections
    finally:
        release.set()
        await asyncio.gather(pending, return_exceptions=True)
        await sdk.disconnect()
