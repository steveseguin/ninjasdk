# Native SDKs: Go, Rust, C, Python, Flutter, Android and Swift

The JavaScript SDK (`vdoninja-sdk.js`) is the reference implementation of the VDO.Ninja client protocol. This
repository also ships native SDKs that implement the same protocol on top of established WebRTC engines, so
applications written in Go, Rust, C or Python, and mobile apps in Flutter, Kotlin/Java or Swift, can publish to and
view from browsers running VDO.Ninja, talk to each other, and use the hosted signaling and TURN infrastructure the
same way the JavaScript SDK does.

| SDK | Directory | WebRTC engine | Best for |
| --- | --- | --- | --- |
| Go | [`go/`](https://github.com/steveseguin/ninjasdk/blob/main/go/README.md) | [pion/webrtc](https://github.com/pion/webrtc) | servers, bots, recorders, CLI tools, cross-compiled binaries |
| Rust | [`rust/`](https://github.com/steveseguin/ninjasdk/blob/main/rust/README.md) | [webrtc-rs](https://github.com/webrtc-rs/webrtc) | Linux services and desktop apps that need memory safety and low overhead |
| C | [`c/`](https://github.com/steveseguin/ninjasdk/blob/main/c/README.md) | [libdatachannel](https://github.com/paullouisageneau/libdatachannel) | embedded devices, encoders, plugins, bindings for other languages |
| Python | [`python/`](https://github.com/steveseguin/ninjasdk/blob/main/python/README.md) | [aiortc](https://github.com/aiortc/aiortc) | scripting, prototyping, Raspberry Pi and automation |
| Dart / Flutter | [`dart/`](https://github.com/steveseguin/ninjasdk/blob/main/dart/README.md) | [flutter_webrtc](https://pub.dev/packages/flutter_webrtc) | Flutter apps on Android, iOS, desktop and web |
| Kotlin / Java | [`kotlin/`](https://github.com/steveseguin/ninjasdk/blob/main/kotlin/README.md) | Google libwebrtc ([stream-webrtc-android](https://github.com/GetStream/webrtc-android)) | native Android apps |
| Swift | [`swift/`](https://github.com/steveseguin/ninjasdk/blob/main/swift/README.md) | Google WebRTC ([stasel/WebRTC](https://github.com/stasel/WebRTC)) | native iOS, macOS and tvOS apps |

The Flutter, Android and Swift SDKs are the "mobile basics": the same signaling, hashing, encryption,
publishing, viewing, data channels, pub/sub and request/response as the others, with media supplied by the
platform's own capture APIs. They deliberately leave out file transfer, resources, reserved-channel helpers, WHIP/WHEP
and screen capture. Each is split into a protocol core that is unit-tested against the shared vectors without WebRTC
(`vdoninja_core`, `vdoninja-core`, `VDONinjaCore`) and a thin engine layer.

All of them share one conformance suite: [`spec/vectors.json`](https://github.com/steveseguin/ninjasdk/blob/main/spec/vectors.json) is generated from the JavaScript
SDK (`spec/generate-vectors.cjs`) and every native SDK tests its hashing, encryption and sanitization against it.
[`spec/interop/run_interop.py`](https://github.com/steveseguin/ninjasdk/blob/main/spec/interop/run_interop.py) runs every publisher/viewer language pair, including
the Node build of the JavaScript SDK, against a local signaling server.

## Feature matrix

| Capability | JavaScript | Go | Rust | C | Python | Flutter | Android | Swift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Signaling: connect, reconnect with intent replay, rooms, claim/director | yes | yes | yes | yes | yes | yes | yes | yes |
| Stream and room hashing, SDP/ICE encryption, `password: false` | yes | yes | yes | yes | yes | yes | yes | yes |
| Data-only publishing (`announce`) and viewing | yes | yes | yes | yes | yes | yes | yes | yes |
| Control channel protocol (prefs, info, ping/pong, bye, videoMuted, obsState) | yes | yes | yes | yes | yes | yes | yes | yes |
| `sendData` targeting (uuid, type, preference, signaling fallback) | yes | yes | yes | yes | yes | yes | yes | yes |
| Pub/sub channels and request/response | yes | yes | yes | yes | yes | yes | yes | yes |
| Native file transfer (host, list, request, cancel) | yes | yes | yes | yes | yes | no | no | no |
| Reserved `x-` channels and the `x-bin` binary lane | yes | yes | yes | yes | yes | receive | receive | receive |
| Resources channel (receive) | yes | yes | yes | receive | yes | no | no | no |
| Media publishing | browser tracks | pion tracks (RTP or samples) | sample tracks | RTP or encoded samples (libdatachannel packetizers) | aiortc tracks | `MediaStream` tracks (getUserMedia) | libwebrtc tracks (camera/mic capturers) | WebRTC tracks (`RTCCameraVideoCapturer`) |
| Media viewing | browser | RTP packets / recording | RTP packets | RTP packets | aiortc tracks | `track` events → `RTCVideoRenderer` | `track` events → `SurfaceViewRenderer` | `track` events → `RTCMTLVideoView` |
| Track replacement (camera switch) and viewer audio/video prefs | yes | yes | renegotiates | stops sending | yes | yes | yes | yes |
| Keyframe requests (PLI) | n/a | yes | yes | yes (event) | via aiortc | engine | engine | engine |
| Trickle ICE, ICE candidate bundling | yes | yes | yes | yes | no (aiortc gathers first) | yes | yes | yes |
| ICE restart | yes | yes | reconnects | reconnects | no | yes | yes | yes |
| TURN: hosted list by proximity, custom, forced relay | yes | yes | yes | yes (UDP relays) | yes | yes | yes | yes |
| WHIP / WHEP clients | yes | yes | yes | no | yes | no | no | no |
| Local signaling server for LAN, offline and tests | — | `vdoninja-signal` | `vdoninja-signal` | `vdoninja-signal` | `python -m vdoninja.signalserver` | use another SDK's | use another SDK's | use another SDK's |
| autoConnect (half/full mesh) | yes | yes | yes | yes | yes | yes | yes | yes |
| Statistics | yes | yes | yes | via libdatachannel | yes | via `pc.getStats()` | via `pc.getStats()` | via `pc.statistics()` |

"reconnects" means the engine lacks ICE restart, so a failed connection is torn down and re-requested from the
publisher instead; the application sees `peerDisconnected` and `connectionFailed` followed by a fresh `peerConnected`.

### Connection lifecycle (all SDKs, as in the JavaScript SDK)

* A peer connection that fails or stays disconnected past the grace period gets one bounded recovery attempt
  (`iceRestart`: the publisher sends an ICE-restart offer over signaling, a viewer asks the publisher with
  `iceRestartRequest`). If it is still down after the connection timeout the SDK closes it and emits
  `peerDisconnected` then `connectionFailed`; viewers then re-request the stream after 2 s.
* `bye` from a peer closes both directions and, on the viewer side, re-requests the stream after 2 s. `hangup`
  closes without retrying: the peer ended the session on purpose.
* `view()` of a publisher that is not online yet fails with the SDK's "not yet available" error, keeps the request
  pending (a `videoaddedtoroom` or `someonejoined` connects it) and re-sends `play` every `viewRetryInterval`
  (15 minutes by default).
* `disconnect()` drops the connection intent (room, publish, views): a later `connect()` starts clean and an
  unexpected socket drop after it replays nothing. An unexpected drop while connected reconnects with exponential
  backoff and replays room, seed and views; the attempt counter resets on a manual `connect()`.

### Interoperability

`spec/interop/run_interop.py` connects every publisher/viewer pair over a local signaling server and exchanges
data-channel probes and one request/response. All pairs between the JavaScript (Node), Go, C, Rust and Python
SDKs pass, with one known engine limitation: a **Rust publisher cannot be viewed by the Python SDK**. The rtc crate
initiates the SCTP association only when it is the DTLS client and aiortc only when it is ICE-controlling; with
Rust offering, neither side sends the SCTP INIT. Browsers, pion and libdatachannel initiate from either role, so
every other combination works, including Python publishing to Rust. Use another engine on one side if you need
that direction. The JavaScript peer in the matrix needs `node-datachannel` 0.27 or newer (older builds generate
DTLS certificates that aiortc rejects).

## Protocol summary

The native SDKs implement the routed VDO.Ninja signaling protocol used by `wss.vdo.ninja` (the "wss2" format).
Everything below is what the JavaScript SDK does; the native SDKs mirror it so they are indistinguishable to the
server and to browser peers.

* **Sanitization.** Stream IDs: `[^A-Za-z0-9_]+` runs become `_`, at most 64 characters, generated (12 random
  alphanumerics) when empty. Rooms: same rule, at most 30 characters. Passwords: trimmed and
  `encodeURIComponent`-encoded. Labels: line breaks removed, at most 100 characters.
* **Hashing.** With a password `P` and salt `S` (default `vdo.ninja`), published stream IDs on the wire are
  `streamID + sha256(P+S)[:6]` and room IDs are `sha256(room+P+S)[:16]`. The default password is
  `someEncryptionKey123`; `password: false` disables hashing and encryption entirely.
* **Encryption.** SDP and ICE candidates are JSON-serialized and encrypted with AES-256-CBC (PKCS#7), key
  `sha256(P+S)`, random 16-byte IV, both sent as hex (`description`/`candidates` plus `vector`).
* **Requests.** `joinroom {roomid, claim?, streamID?}` → `listing {list, director?, claim?}`; `{leave: true}` leaves
  the room; `seed {streamID}` registers a publisher (one publish per signaling connection; reconnect to change it); `play {streamID}` asks the server to find the publisher, which receives
  `offerSDP {UUID}`; room members receive `videoaddedtoroom` and `someonejoined`; `alert`/`error` carry text.
* **Routing.** Any message with a `UUID` is forwarded to that peer with `UUID` rewritten to the sender. Offers carry
  `{UUID, session (8 chars), streamID (hashed), description, vector}`; answers echo `session` and `streamID`;
  candidates are `{UUID, type: "remote" (viewer → publisher) | "local" (publisher → viewer), candidates, vector,
  session}`, bundled with a 70 ms timer that doubles up to 1 s, and sent over the control channel once it is open.
  `bye`/`hangup` end a connection (viewers retry the stream after `bye`, not after `hangup`).
* **Control channel.** The publisher creates `sendChannel`. The viewer sends `{audio, video, downloads,
  info:{label}, allowresources}`; the publisher sends `{info:{label, meta, ...}}`. `ping`/`pong`, `pipe`
  (application data), `bye`, `videoMuted`, `iceRestartRequest`, `fileList`/`requestFile` and `obsState` share the
  channel. `pipe` payloads with `type` `subscribe`, `unsubscribe`, `channelMessage`, `request` or `response`
  implement pub/sub and RPC; everything else is delivered as `dataReceived`.
* **Other channels.** File transfers use a channel labeled with the file ID: a text header
  `{type:"filetransfer", size, filename, id}`, 16 KiB binary chunks, then `EOF1` (complete) or `EOF2` (cancelled).
  `x-` labels are reserved for applications (`x-bin` is the binary lane); `resources` carries VDO.Ninja overlay
  resources; `chunked` is VDO.Ninja's own chunked transfer and is reported as unsupported.
* **TURN.** `GET https://turnservers.vdo.ninja/?ts=…` returns `{servers:[{username, credential, urls, tz, udp}]}`.
  Clients pick the two closest UDP relays and one TCP relay by time-zone distance; a built-in list is the fallback.

## Hosted service and licensing

The native SDKs are licensed under MPL-2.0 (examples and WHIP/WHEP helpers under MIT), the same terms as the
JavaScript SDK core; see [LICENSING.md](../LICENSING.md). The mobile SDKs were written from the JavaScript SDK's
protocol and verified against the shared vectors; they contain no code from the VDO.Ninja mobile apps. VDO.Ninja itself is AGPL-3.0; these SDKs are independent
implementations of its client protocol and do not include VDO.Ninja code.

Connecting to `wss.vdo.ninja` and the hosted TURN servers is subject to the VDO.Ninja Terms of Service. The SDKs
are the supported way to use that infrastructure: only WebRTC handshake data may pass through the signaling server,
application data must travel over peer connections, and rate limits apply. Talking to the hosted servers with a
custom client that is not one of these SDKs requires permission. For LAN or offline use, run the included
`vdoninja-signal` server or [websocket_server](https://github.com/steveseguin/websocket_server).
