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


@pytest.mark.parametrize("override", [None, "", " \t ", False, "false", "0", "off", "café & literal%20"])
async def test_room_password_override_and_reconnect(signal_host, override):
    from vdoninja.crypto import hash_room
    sdk = make(signal_host, password="old %20 password")
    expected = VDONinja(password="old %20 password" if override is None else override)
    sent = []
    send = sdk._send_ws
    sdk._send_ws = lambda message: sent.append(dict(message)) or send(message)
    try:
        await sdk.connect()
        await sdk.join_room("password_room", password=override)
        for _ in range(2):
            pw = expected._effective_password()
            assert sdk._effective_password() == pw
            assert sdk.hashed_stream_id("camera") == expected.hashed_stream_id("camera")
            room = "password_room" if pw is None else hash_room("password_room", pw, sdk.salt)
            assert [m for m in sent if m.get("request") == "joinroom"][-1]["roomid"] == room
            await sdk.leave_room()
            await sdk.connect()
            await sdk.join_room("password_room")
    finally:
        await sdk.disconnect()


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
        info = []
        view.on("peerInfo", lambda ev: info.append(ev))

        def on_track(ev):
            assert info, "media arrived before native publisher info"
            tracks.append(ev.track)

        view.on("track", on_track)
        await view.view("pycam")
        for _ in range(100):
            if len(tracks) >= 2:
                break
            await asyncio.sleep(0.1)
        kinds = {t.kind for t in tracks}
        assert kinds == {"audio", "video"}
        assert info, "publisher must send info even without a label"
        video = next(t for t in tracks if t.kind == "video")
        frame = await asyncio.wait_for(video.recv(), 10)
        assert frame.width > 0
    finally:
        await pub.disconnect()
        await view.disconnect()


async def test_initial_offer_is_data_only():
    sdk = make("ws://127.0.0.1:1")
    sdk.publishing = True
    sdk._data_only = False
    sdk._local_tracks = [VideoStreamTrack(), AudioStreamTrack()]
    try:
        conn = await sdk._create_connection("peer", "publisher")
        offer = await sdk._create_offer(conn)
        assert "m=application " in offer.sdp
        assert "m=video " not in offer.sdp and "m=audio " not in offer.sdp
        conn.allow_video = True
        await sdk._update_tracks(conn)
        await sdk.add_track(VideoStreamTrack())
        assert not conn.pc.getSenders(), "media attached before info exchange"
    finally:
        await sdk.disconnect()


@pytest.mark.parametrize("audio,video", [(False, False), (True, False), (False, True)])
async def test_media_preferences_then_enable_both(signal_host, audio, video):
    pub = make(signal_host)
    view = make(signal_host)
    tracks = {}
    view.on("track", lambda ev: tracks.update({ev.track.kind: ev.track}))

    async def until(predicate):
        async def poll():
            while not predicate():
                await asyncio.sleep(0.02)
        await asyncio.wait_for(poll(), 10)

    try:
        await pub.connect()
        await pub.publish([VideoStreamTrack(), AudioStreamTrack()], "preferences")
        await view.connect()
        conn = await view.view("preferences", audio=audio, video=video)
        await until(lambda: conn.control_open and bool(pub.peers()))
        publisher = pub.connection(pub.peers()[0], "publisher")
        offers = []
        send_control = publisher.send_control

        def capture(message):
            if "description" in message:
                offers.append(dict(message))
            return send_control(message)

        publisher.send_control = capture
        await until(lambda: publisher.info_sent and publisher.allow_audio == audio and publisher.allow_video == video)
        expected = {kind for kind, enabled in [("audio", audio), ("video", video)] if enabled}
        await until(lambda: set(tracks) == expected)
        # Give any wrongly attached/unrequested track time to arrive.
        await asyncio.sleep(0.15)
        assert set(tracks) == expected
        assert {s.kind for s in publisher.senders} == expected
        assert conn.send_control({"audio": True, "video": True})
        await until(lambda: set(tracks) == {"audio", "video"})
        assert offers and all(m.get("streamID") == "preferences" for m in offers)
        for kind, track in tracks.items():
            frame = await asyncio.wait_for(track.recv(), 10)
            assert frame.samples > 0 if kind == "audio" else frame.width > 0

        # Disabling/resuming an existing sender must not create another track.
        senders = list(publisher.senders)
        assert conn.send_control({"audio": False, "video": False})
        await until(lambda: all(s.track is None for s in publisher.senders))
        assert conn.send_control({"audio": True, "video": True})
        await until(lambda: all(s.track is not None for s in publisher.senders))
        assert publisher.senders == senders
        assert view.connection(conn.uuid, "viewer") is conn
    finally:
        await pub.disconnect()
        await view.disconnect()


async def test_discovery_retries_coalesce_and_stop():
    from vdoninja.sdk import _ViewOptions
    sdk = make("ws://127.0.0.1:1")
    sdk._connected = True
    sdk._pending_views["late"] = _ViewOptions()
    sent = []
    sdk._send_ws = lambda message: sent.append(message) or True
    try:
        for _ in range(20):
            sdk._handle_video_added({"streamID": sdk.hashed_stream_id("late"), "UUID": "peer"})
        assert len(sdk._view_retry_tasks) == 1
        await sdk.stop_viewing("late")
        await asyncio.sleep(0.15)
        assert not sent and not sdk._view_retry_tasks
    finally:
        await sdk.disconnect()


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


@pytest.mark.parametrize("leave_room", [False, True])
async def test_disconnect_clears_intent(signal_host, leave_room):
    sdk = make(signal_host, reconnect_delay=0.1)
    try:
        await sdk.connect()
        await sdk.join_room("old-room")
        await sdk.announce("stale")
        if leave_room:
            await sdk.leave_room()
            assert not sdk.connected
            assert sdk.room == ""
        else:
            await sdk.disconnect()
        # A fresh session with no room or stream, then an unexpected drop: the old
        # intent must not be replayed by the reconnect.
        await sdk.connect()
        reconnected = asyncio.ensure_future(sdk.wait_for("reconnected", timeout=10))
        await sdk._ws.close()
        await reconnected
        assert not sdk.publishing
        assert sdk.stream_id is None
        assert not sdk.room_joined
    finally:
        await sdk.disconnect()


async def test_data_requires_peer_channel(monkeypatch):
    """A connected signaling socket is never an application-data transport."""
    from vdoninja.sdk import _PeerPair

    sdk = make("ws://unused")
    sdk._connected = True
    sdk.connections["unopened-peer"] = _PeerPair()
    sent = []
    monkeypatch.setattr(sdk, "_send_ws", lambda msg: sent.append(msg) or True)
    assert not sdk.send_data("payload", "unopened-peer")
    # An obsolete caller option must not re-enable the removed relay path.
    assert not sdk.send_data("payload", {"uuid": "unopened-peer", "allowFallback": True})
    assert not sdk.send_ping("unopened-peer")
    sdk.subscribe("updates")
    sdk.unsubscribe("updates")
    assert sent == []

    events = []
    sdk.on("dataReceived", events.append)
    await sdk._handle_signaling({"UUID": "unopened-peer", "__fallback": True, "pipe": "payload"})
    assert events == []
    sdk._connected = False


async def test_stream_notice_preserves_view_preferences():
    from vdoninja.sdk import _ViewOptions

    sdk = make("ws://unused")
    prefs = _ViewOptions(audio=False, video=False, downloads=False)
    sdk._pending_views["late"] = prefs
    sdk._handle_video_added({"streamID": sdk.hashed_stream_id("late"), "UUID": "publisher"})
    assert sdk._pending_views.get("late") is prefs, "offer arriving before retry lost preferences"
    await sdk.disconnect()


async def test_add_track_does_not_duplicate_an_attached_kind(signal_host):
    """add_track must go through the locked media path, not attach senders itself.

    Attaching directly duplicated a kind the preference path was already
    attaching: two senders and two renegotiations for one track.
    """
    pub = make(signal_host)
    view = make(signal_host)

    async def until(predicate):
        async def poll():
            while not predicate():
                await asyncio.sleep(0.02)
        await asyncio.wait_for(poll(), 10)

    def video_senders(conn):
        return [s for s in conn.pc.getSenders() if s.track is not None and s.track.kind == "video"]

    try:
        await pub.connect()
        await pub.publish([AudioStreamTrack()], "dupcam", room="py-dup")
        await view.connect()
        await view.join_room("py-dup")
        conn = await view.view("dupcam", audio=True, video=False)
        await until(lambda: conn.control_open and bool(pub.peers()))
        publisher = pub.connection(pub.peers()[0], "publisher")
        await until(lambda: publisher.info_sent)

        # The viewer wants video from here on.
        publisher.allow_video = True
        await pub.add_track(VideoStreamTrack())
        assert len(video_senders(publisher)) == 1

        await pub.add_track(VideoStreamTrack())
        assert len(video_senders(publisher)) == 1, "second video track added a duplicate sender"
    finally:
        await pub.disconnect()
        await view.disconnect()
