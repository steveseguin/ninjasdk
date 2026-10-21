# VDO.Ninja SDK for Python

Signaling uses the existing VDO.Ninja protocol. Application data and native `ping`/`pong`/`bye` messages use peer data channels; there is no WebSocket application-data fallback or client-supplied `from` field. Wait for the control channel to open before sending data.

Pub/sub and request/response helpers preserve the JS SDK application protocol inside native `pipe` messages. They require a compatible SDK/application at the other end; the VDO.Ninja page forwards generic `pipe` data to its embedding application and does not implement those helpers itself.

Leaving a room disconnects its peers and signaling socket: the handshake server has no `leave` command. Reconnect before joining another room or publishing again. Await the leave operation in asynchronous APIs (Rust, Python, Dart and Swift).

An asyncio implementation of the VDO.Ninja SDK on top of [aiortc](https://github.com/aiortc/aiortc). It speaks the
same signaling protocol, hashing and encryption as the JavaScript SDK, so Python programs can publish audio, video
and data to browsers running VDO.Ninja, view streams from them, and interoperate with the Go, Rust and C SDKs in this
repository.

Good for scripting, automation, Raspberry Pi projects and prototyping. If you need a ready-made camera publisher for
Linux hardware, see [raspberry_ninja](https://github.com/steveseguin/raspberry_ninja); this package is the library
underneath such tools.

License: MPL-2.0 (same as the SDK core). `vdoninja/whip.py` and the examples are MIT. aiortc is BSD-3-Clause.

## Install

```bash
pip install ./python              # from this repository
pip install -e './python[test]'   # with the test dependencies
```

Python 3.9 or newer. aiortc needs libopus and libvpx (wheels bundle them on most platforms); ffmpeg is needed by
aiortc's media helpers (`MediaPlayer`, `MediaRecorder`).

## Data channel quick start

```python
import asyncio
from vdoninja import VDONinja

async def main():
    sdk = VDONinja(password="mysecret")          # password=False disables hashing/encryption
    sdk.on("dataReceived", lambda ev: print(ev.uuid, ev.data))
    sdk.on("dataChannelOpen", lambda ev: sdk.send_ping(ev.uuid))
    await sdk.connect()
    stream_id = await sdk.announce("my-python-stream")   # data-only publisher
    print("viewers can open https://vdo.ninja/?view=%s&password=mysecret" % stream_id)
    await asyncio.sleep(3600)
    await sdk.disconnect()

asyncio.run(main())
```

Viewing side: `await sdk.view("their-stream")` returns a `Connection` once the publisher's offer has arrived; when the
publisher is not online yet it raises after `timeout` seconds but the request stays pending and connects when the
stream appears. `await sdk.auto_connect(room)` joins a room, announces and views every other member (half mesh by
default).

Events are plain callbacks (`sdk.on(name, handler)` returns an unsubscribe function; `await sdk.wait_for(name)`
awaits one). Names match the JavaScript SDK: `connected`, `disconnected`, `reconnecting`, `listing`,
`videoaddedtoroom`, `peerConnected`, `dataChannelOpen`, `dataReceived`, `peerInfo`, `peerLatency`, `track`,
`channelMessage`, `fileList`, `fileTransferStart/Progress/Complete`, `resourceReceived`, `bye`, `error`, ...

## Publish media

```python
from aiortc.contrib.media import MediaPlayer
from vdoninja import VDONinja

player = MediaPlayer("/dev/video0", format="v4l2", options={"video_size": "1280x720"})
sdk = VDONinja(label="Python camera")
await sdk.connect()
await sdk.publish([player.video], "python-cam", room="myroom")
```

Any aiortc `MediaStreamTrack` works: `MediaPlayer` for files, devices and RTSP, or a custom track that yields
`av.VideoFrame`/`av.AudioFrame` objects. Each viewer gets its own peer connection; `add_track()` renegotiates
existing viewers.

## View media

```python
from aiortc.contrib.media import MediaRecorder

recorder = MediaRecorder("out.mp4")
sdk.on("track", lambda ev: recorder.addTrack(ev.track))
await sdk.connect()
await sdk.view("their-stream")
await recorder.start()
```

`examples/record.py` is a complete recorder; `examples/whip_whep.py` shows the WHIP/WHEP clients.

## API overview

| Area | Methods |
| --- | --- |
| Lifecycle | `connect()`, `disconnect()`, `connected` |
| Rooms | `join_room(room, password=None, claim=False)`, `leave_room()` |
| Publishing | `announce(stream_id=None, room=...)` (data only), `publish(tracks, stream_id=None, ...)`, `add_track(track)`, `stop_publishing()` |
| Viewing | `view(stream_id, audio=True, video=True, label="", downloads=True, allowresources=False, timeout=15)`, `stop_viewing(stream_id)`, `auto_connect(room, mode="half"|"full", ...)` |
| Data | `send_data(data, target=None)` (target: UUID or `{"uuid","type","streamID","preference"}`), `send_ping(uuid=None)` |
| Pub/sub | `subscribe(*channels)`, `unsubscribe(*channels)`, `publish_to_channel(channel, data, target="all")` |
| RPC | `on_request(type, handler)` (sync or async `(data, from_uuid) -> result`), `await request(type, data, uuid, timeout=5)`, `respond(request_id, data, uuid)` |
| Binary | `await send_binary(uuid, bytes)` (reserved `x-bin` lane), `await open_channel(uuid, "x-label", ...)` returns an `RTCDataChannel` |
| Files | `host_file(name, data, restricted=None)`, `unhost_file(id)`, `hosted_files()`, `await request_file(uuid, id, stream=False)` |
| Resources | `await send_resource(uuid, template_name, data, mime_type)` |
| Introspection | `peers()`, `connection(uuid, kind)`, `await stats(uuid)`, `await peer_quality(uuid)` |
| Protocol helpers | `vdoninja.crypto.generate_hash`, `encrypt_message`, `decrypt_message`; `vdoninja.sanitize.*` |

### Constructor options

`VDONinja(host="wss://wss.vdo.ninja", *, room=None, password=None, salt="vdo.ninja", label="", meta=None,
turn="auto"|False|[RTCIceServer], force_tcp=False, stun_servers=None, max_reconnect_attempts=5,
reconnect_delay=1.0, connection_timeout=20.0, view_retry_interval=900.0, auto_ping_viewer=False)`

`password=None` uses the shared default password, `password=False` disables hashing and encryption (JavaScript
`password: false`).

## Local signaling server

```bash
python -m vdoninja.signalserver --port 8080
# SDKs: VDONinja("ws://127.0.0.1:8080")
# Browser: https://vdo.ninja/?view=x&wss2=127.0.0.1:8080  (TLS required for https pages)
```

A VDO.Ninja-compatible routed signaling server (the "wss2" protocol) for LAN, offline and test use. The same class
(`vdoninja.signalserver.SignalServer`) powers the test suite.

## Engine notes

aiortc gathers all ICE candidates before producing an offer or answer (no trickle ICE), has no ICE restart (failed
connections are re-requested from the publisher) and does not support relay-only ICE. Media encoding and decoding
run in Python/ffmpeg and are CPU-bound; for high resolutions prefer the Go, Rust or C SDKs or a hardware encoder.
A Python viewer cannot connect to a Rust SDK publisher (aiortc initiates SCTP only when ICE-controlling and the Rust
engine only as the DTLS client); publishing from Python to Rust, and every other engine pairing, works.

## Tests

```bash
pip install -e './python[test]'
pytest -q python/tests
```

`test_vectors.py` checks hashing, encryption and sanitization against `spec/vectors.json`; `test_sdk.py` runs two
SDK instances against the embedded signaling server (data, RPC, pub/sub, binary, file transfer, media, autoConnect,
no-password mode, pending views).

## Hosted service notice

Use of the signaling, TURN and related services operated by Steve Seguin is subject to the applicable Terms of
Service and operational policies. This SDK is the supported way to use them; only WebRTC handshake data is allowed
through the signaling server, and application data must travel over peer-to-peer channels. Self-hosting is covered by
[websocket_server](https://github.com/steveseguin/websocket_server) and
[offline_deployment](https://github.com/steveseguin/offline_deployment).
