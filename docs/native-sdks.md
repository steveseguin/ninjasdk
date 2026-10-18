# Native SDKs: Go, Rust, C and Python

The JavaScript SDK (`vdoninja-sdk.js`) is the reference implementation of the VDO.Ninja client protocol. This
repository also ships native SDKs that implement the same protocol on top of established WebRTC engines, so
applications written in Go, Rust, C or Python can publish to and view from browsers running VDO.Ninja, talk to
each other, and use the hosted signaling and TURN infrastructure the same way the JavaScript SDK does.

| SDK | Directory | WebRTC engine | Best for |
| --- | --- | --- | --- |
| Go | [`go/`](../go/README.md) | [pion/webrtc](https://github.com/pion/webrtc) | servers, bots, recorders, CLI tools, cross-compiled binaries |
| Rust | [`rust/`](../rust/README.md) | [webrtc-rs](https://github.com/webrtc-rs/webrtc) | Linux services and desktop apps that need memory safety and low overhead |
| C | [`c/`](../c/README.md) | [libdatachannel](https://github.com/paullouisageneau/libdatachannel) | embedded devices, encoders, plugins, bindings for other languages |
| Python | [`python/`](../python/README.md) | [aiortc](https://github.com/aiortc/aiortc) | scripting, prototyping, Raspberry Pi and automation |

All four share one conformance suite: [`spec/vectors.json`](../spec/vectors.json) is generated from the JavaScript
SDK (`spec/generate-vectors.cjs`) and every native SDK tests its hashing, encryption and sanitization against it.
[`spec/interop/run_interop.py`](../spec/interop/run_interop.py) runs every publisher/viewer language pair, including
the Node build of the JavaScript SDK, against a local signaling server.

## Feature matrix

| Capability | JavaScript | Go | Rust | C | Python |
| --- | --- | --- | --- | --- | --- |
| Signaling: connect, reconnect with intent replay, rooms, claim/director | yes | yes | yes | yes | yes |
| Stream and room hashing, SDP/ICE encryption, `password: false` | yes | yes | yes | yes | yes |
| Data-only publishing (`announce`) and viewing | yes | yes | yes | yes | yes |
| Control channel protocol (prefs, info, ping/pong, bye, videoMuted, obsState) | yes | yes | yes | yes | yes |
| `sendData` targeting (uuid, type, preference, signaling fallback) | yes | yes | yes | yes | yes |
| Pub/sub channels and request/response | yes | yes | yes | yes | yes |
| Native file transfer (host, list, request, cancel) | yes | yes | yes | yes | yes |
| Reserved `x-` channels and the `x-bin` binary lane | yes | yes | yes | yes | yes |
| Resources channel (receive) | yes | yes | yes | receive | yes |
| Media publishing | browser tracks | pion tracks (RTP or samples) | sample tracks | RTP or encoded samples (libdatachannel packetizers) | aiortc tracks |
| Media viewing | browser | RTP packets / recording | RTP packets | RTP packets | aiortc tracks |
| Keyframe requests (PLI) | n/a | yes | yes | yes (event) | via aiortc |
| Trickle ICE, ICE candidate bundling | yes | yes | yes | yes | no (aiortc gathers first) |
| ICE restart | yes | yes | reconnects | reconnects | no |
| TURN: hosted list by proximity, custom, forced relay | yes | yes | yes | yes (UDP relays) | yes |
| WHIP / WHEP clients | yes | yes | yes | no | yes |
| Local signaling server for LAN, offline and tests | — | `vdoninja-signal` | `vdoninja-signal` | `vdoninja-signal` | `python -m vdoninja.signalserver` |
| autoConnect (half/full mesh) | yes | yes | yes | yes | yes |
| Statistics | yes | yes | yes | via libdatachannel | yes |

"reconnects" means the engine lacks ICE restart, so a failed connection is torn down and re-requested from the
publisher instead; the application sees `connectionFailed` followed by a fresh `peerConnected`.

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
* **Requests.** `joinroom {roomid, claim?, streamID?}` → `listing {list, director?, claim?}`; `seed {streamID}`
  registers a publisher; `play {streamID}` asks the server to find the publisher, which receives
  `offerSDP {UUID}`; room members receive `videoaddedtoroom` and `someonejoined`; `alert`/`error` carry text.
* **Routing.** Any message with a `UUID` is forwarded to that peer with `UUID` rewritten to the sender. Offers carry
  `{UUID, session (8 chars), streamID (hashed), description, vector}`; answers echo `session` and `streamID`;
  candidates are `{UUID, type: "remote" (viewer → publisher) | "local" (publisher → viewer), candidates, vector,
  session}`, bundled with a 70 ms timer that doubles up to 1 s, and sent over the control channel once it is open.
  `bye`/`hangup` end a connection.
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
JavaScript SDK core; see [LICENSING.md](../LICENSING.md). VDO.Ninja itself is AGPL-3.0; these SDKs are independent
implementations of its client protocol and do not include VDO.Ninja code.

Connecting to `wss.vdo.ninja` and the hosted TURN servers is subject to the VDO.Ninja Terms of Service. The SDKs
are the supported way to use that infrastructure: only WebRTC handshake data may pass through the signaling server,
application data must travel over peer connections, and rate limits apply. Talking to the hosted servers with a
custom client that is not one of these SDKs requires permission. For LAN or offline use, run the included
`vdoninja-signal` server or [websocket_server](https://github.com/steveseguin/websocket_server).
