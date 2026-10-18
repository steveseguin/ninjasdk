import asyncio
import os

import pytest
from aiortc.mediastreams import AudioStreamTrack, VideoStreamTrack

from vdoninja import StreamNotYetAvailable, VDONinja


def make(host, **kwargs):
    kwargs.setdefault("password", "test pass!")
    kwargs.setdefault("turn", False)
    kwargs.setdefault("stun_servers", [])
    return VDONinja(host, **kwargs)


@pytest.mark.parametrize("media", [False, True])
async def test_publishing_survives_signaling_reconnect(signal_host, media):
    pub = make(signal_host, reconnect_delay=0.05)
    view = make(signal_host)
    try:
        await pub.connect()
        if media:
            await pub.publish([AudioStreamTrack()], "reconnect-test")
        else:
            await pub.announce("reconnect-test")
        reconnected = asyncio.create_task(pub.wait_for("reconnected", timeout=5))
        await pub._ws.close()
        await reconnected
        assert pub.publishing
        await view.connect()
        opened = asyncio.create_task(view.wait_for("dataChannelOpen", timeout=10))
        await view.view("reconnect-test")
        await opened
    finally:
        await view.disconnect()
        await pub.disconnect()


async def test_data_round_trip(signal_host):
    pub = make(signal_host, label="Py publisher")
    view = make(signal_host)
    try:
        await pub.connect()
        await pub.join_room("py-test-room")
        sid = await pub.announce("pypub")
        assert sid == "pypub"
        await view.connect()
        await view.join_room("py-test-room")

        pub_open = asyncio.ensure_future(pub.wait_for("dataChannelOpen", timeout=15))
        info_fut = asyncio.ensure_future(view.wait_for("peerInfo", timeout=15))
        conn = await view.view("pypub", audio=False, video=False, label="Py viewer")
        assert conn.stream_id == "pypub" and conn.type == "viewer"
        viewer_uuid = (await pub_open).uuid
        assert (await info_fut).info["label"] == "Py publisher"

        got = asyncio.ensure_future(pub.wait_for("dataReceived", timeout=10))
        assert view.send_data({"hello": "publisher"})
        ev = await got
        assert ev.data == {"hello": "publisher"} and ev.uuid == viewer_uuid

        got = asyncio.ensure_future(view.wait_for("dataReceived", timeout=10))
        assert pub.send_data("plain string", viewer_uuid)
        assert (await got).data == "plain string"

        lat = asyncio.ensure_future(view.wait_for("peerLatency", timeout=10))
        assert view.send_ping(conn.uuid)
        assert 0 <= (await lat).latency < 5000

        pub.on_request("add", lambda data, _from: data["a"] + data["b"])
        assert await view.request("add", {"a": 2, "b": 3}, conn.uuid) == 5

        async def failing(data, _from):
            raise RuntimeError("nope")

        pub.on_request("fail", failing)
        with pytest.raises(Exception, match="nope"):
            await view.request("fail", None, conn.uuid)

        subscribed = asyncio.ensure_future(view.wait_for("peerSubscribed", timeout=10))
        pub.subscribe("news")
        await subscribed
        chan = asyncio.ensure_future(pub.wait_for("channelMessage", timeout=10))
        view.publish_to_channel("news", "headline")
        ev = await chan
        assert ev.channel_name == "news" and ev.data == "headline"

        payload = os.urandom(100_000)
        binary = asyncio.ensure_future(pub.wait_for("binaryReceived", timeout=10))
        await view.send_binary(conn.uuid, payload[:60_000])
        assert (await binary).bytes == payload[:60_000]

        files = asyncio.ensure_future(view.wait_for("fileList", timeout=10))
        entry = pub.host_file("blob.bin", payload)
        listed = (await files).files
        assert listed[0].id == entry.id and listed[0].size == len(payload)
        result = await view.request_file(conn.uuid, entry.id)
        assert result.data == payload and result.name == "blob.bin"

        quality = await view.peer_quality(conn.uuid)
        assert quality is not None

        bye = asyncio.ensure_future(pub.wait_for("peerDisconnected", timeout=10))
        await view.stop_viewing("pypub")
        await bye
    finally:
        await pub.disconnect()
        await view.disconnect()


async def test_media_publish_view(signal_host):
    pub = make(signal_host)
    view = make(signal_host)
    try:
        await pub.connect()
        await pub.publish([VideoStreamTrack(), AudioStreamTrack()], "pycam", room="py-media")
        await view.connect()
        await view.join_room("py-media")
        tracks = []

        async def on_track(ev):
            tracks.append(ev.track)

        view.on("track", on_track)
        await view.view("pycam")
        for _ in range(100):
            if len(tracks) >= 2:
                break
            await asyncio.sleep(0.1)
        kinds = {t.kind for t in tracks}
        assert kinds == {"audio", "video"}
        video = next(t for t in tracks if t.kind == "video")
        frame = await asyncio.wait_for(video.recv(), 10)
        assert frame.width > 0
    finally:
        await pub.disconnect()
        await view.disconnect()


async def test_auto_connect_half_mesh(signal_host):
    a = make(signal_host)
    b = make(signal_host)
    try:
        ca = await a.auto_connect("py-mesh", stream_id="peer_a")
        opened = asyncio.ensure_future(b.wait_for("dataChannelOpen", timeout=15))
        cb = await b.auto_connect("py-mesh", stream_id="peer_b")
        await opened
        got = asyncio.ensure_future(a.wait_for("dataReceived", timeout=10))
        assert b.send_data("mesh hello")
        assert (await got).data == "mesh hello"
        assert len(a.peers()) == 1 and len(b.peers()) == 1
        pa = a.peers()[0]
        assert not (a.connection(pa, "publisher") and a.connection(pa, "viewer"))
        ca["stop"]()
        cb["stop"]()
    finally:
        await a.disconnect()
        await b.disconnect()


async def test_no_password_and_pending_view(signal_host):
    pub = make(signal_host, password=False)
    view = make(signal_host, password=False)
    try:
        await view.connect()
        await view.join_room("late-room")
        with pytest.raises(StreamNotYetAvailable):
            await view.view("late", timeout=0.5)
        opened = asyncio.ensure_future(view.wait_for("dataChannelOpen", timeout=15))
        await pub.connect()
        await pub.join_room("late-room")
        await pub.announce("late")
        await opened
    finally:
        await pub.disconnect()
        await view.disconnect()


async def test_reconnect_restores_publish(signal_host):
    pub = make(signal_host, reconnect_delay=0.1)
    view = make(signal_host)
    try:
        await pub.connect()
        await pub.announce("resume")
        reconnected = asyncio.ensure_future(pub.wait_for("reconnected", timeout=20))
        # Drop the signaling socket underneath the publisher, as a network failure would.
        await pub._ws.close()
        await reconnected
        opened = asyncio.ensure_future(view.wait_for("dataChannelOpen", timeout=15))
        await view.connect()
        await view.view("resume")
        await opened
    finally:
        await pub.disconnect()
        await view.disconnect()
