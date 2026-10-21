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

Review the [SDK integration checklist](#sdk-integration-checklist) before implementing a port, wrapper or demo.

## Feature matrix

| Capability | JavaScript | Go | Rust | C | Python | Flutter | Android | Swift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Signaling: connect, reconnect with intent replay, rooms, claim/director | yes | yes | yes | yes | yes | yes | yes | yes |
| Stream and room hashing, SDP/ICE encryption, `password: false` | yes | yes | yes | yes | yes | yes | yes | yes |
| Data-only publishing (`announce`) and viewing | yes | yes | yes | yes | yes | yes | yes | yes |
| Control channel protocol (prefs, info, ping/pong, bye, videoMuted, obsState) | yes | yes | yes | yes | yes | yes | yes | yes |
| `sendData` targeting over peer data channels (uuid, type, preference) | yes | yes | yes | yes | yes | yes | yes | yes |
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

### Interoperability

`spec/interop/run_interop.py` connects every publisher/viewer pair over a local signaling server and exchanges
data-channel probes and one request/response. All pairs between the JavaScript (Node), Go, C, Rust and Python
SDKs pass, with one known engine limitation: a **Rust publisher cannot be viewed by the Python SDK**. The rtc crate
initiates the SCTP association only when it is the DTLS client and aiortc only when it is ICE-controlling; with
Rust offering, neither side sends the SCTP INIT. Browsers, pion and libdatachannel initiate from either role, so
every other combination works, including Python publishing to Rust. Use another engine on one side if you need
that direction. The JavaScript peer in the matrix needs `node-datachannel` 0.27 or newer (older builds generate
DTLS certificates that aiortc rejects).

## SDK integration checklist

VDO.Ninja is designed around serverless, peer-to-peer communication. Keep media and
application state at the peers; use signaling to establish and recover their connections.
This checklist covers features implemented by the JavaScript SDK and their native ports.
It is a review checklist, not a catalogue of VDO.Ninja's advanced APIs.
The SDK is a basic connector for publishing, receiving and peer communication, not a
replacement for the VDO.Ninja application. Generic WebRTC capabilities do not expand
that scope. The rules below describe the intended contract; known implementation
gaps are called out separately.

### Purpose and transport boundaries

- **Participate, do not scrape.** Never connect to a room, read `listing`, then disconnect
  solely to collect a list of users, even as a one-off lookup. Do not wrap that sequence
  in a polling loop or expose it as a room-status endpoint. Discovery events serve an
  actual participating SDK connection; they are not a user-directory API.
- **Use the page interfaces for page/room status integrations.** Start with the
  [VDO.Ninja `?api` option](https://docs.vdo.ninja/advanced-settings/api-and-midi-parameters/api)
  and [iframe documentation](https://docs.vdo.ninja/guides/iframe-api-documentation),
  including its [connection events](https://docs.vdo.ninja/guides/iframe-api-documentation/iframe-api-basics).
  These references identify the appropriate integration surface; their command sets
  are outside this SDK checklist.
- **Keep the handshake WebSocket for SDK signaling.** No media, files, chat, telemetry,
  presence polling, application RPC, custom greetings or custom goodbye messages.
  A server's ability to route a JSON object does not make that payload appropriate.
  Do not enable an application-data WebSocket fallback when a peer channel is unavailable.
- **Keep application messages on peer channels.** Wait for channel readiness and handle
  unavailable peers explicitly. SDK pub/sub and request/response require compatible
  application handlers at the other end; a native VDO.Ninja page is not automatically
  an SDK RPC responder. Do not treat signaling as an application relay or state store.

### Message shape and connection flow

- **Verify both producer and consumer.** Compare a port with the JS SDK implementation,
  the matching native VDO.Ninja handler and, for signaling, `hss/gemini.js`. Do not
  invent fields, values, envelopes, channel labels or client identity. Unrecognized
  metadata being ignored by a server is not evidence of compatibility.
- **Preserve wire types.** Keep booleans, numbers, strings, objects and arrays as the
  reference expects. Distinguish an absent optional field from `null`, `false`, `0`
  and an empty string. Use the shared sanitization vectors for IDs, rooms and labels;
  keep the full supported signaling URL, including its path and query.
- **Establish the data connection before media.** Connect and join the intended room, if any;
  announce the publisher with `seed`, and request a view with `play`. The publisher
  handles `offerSDP` and creates the ordered `sendChannel` for the initial data-only
  negotiation; the viewer answers. Wait for the channel to open, exchange the native
  `info` object and media preferences, then negotiate the requested media with the
  publisher retaining offer ownership. Creating a channel object beside media tracks
  in the first offer does not satisfy this ordering. Legacy connections without a
  data channel are outside SDK scope.
- **Use the native initial information exchange.** Send the existing `info` envelope
  over the peer control channel before media setup, with the supported fields and
  types. Optional values may be absent; do not replace the exchange with a custom
  greeting or invent metadata, acknowledgement fields or another handshake protocol.
- **Keep the media baseline small.** Target one audio track and one primary video
  track. Stereo channels within one audio track are not multiple audio tracks.
  Accepting an array of tracks does not establish interoperable multiple-audio or
  secondary-screen-share support. Do not advertise the native page's second screen
  track as an SDK feature without an explicit JS SDK contract and matching tests;
  it is outside this checklist's supported baseline.
- **Match the peer, direction and session.** Use server-assigned peer UUIDs and the
  negotiated session. Queue early ICE only within bounded limits, apply it after
  matching remote SDP, and discard stale-session candidates. Keep publishing and
  viewing directions separate; retain the requested preferences on replacement.
- **Treat discovery as incomplete.** A room listing or stream announcement is not
  proof of an open data channel, playable media, a complete user profile or authorization
  to issue application commands. Do not assume labels or UUIDs are present in every event.
- **Use native teardown.** Send `{bye:true}` over an open peer control channel and
  allow delivery before closing. Do not invent a WebSocket bye fallback or a room
  `leave` command. Native ports leave by closing their room signaling connection;
  reconnect before joining another room. Cancel pending work and finalize recordings.
  One viewer leaving must not terminate a live publisher or unrelated receiving work.

### Passwords, salt and encryption

- **Keep default, disabled and literal passwords distinct.** Follow the
  [input table below](#password-inputs). Omitted/empty SDK passwords select the shared
  default; explicit disable flags turn password protection off. SDK strings `"false"`,
  `"0"` and `"off"` are literal passwords, although those values disable protection
  in ordinary browser password URLs. Never use a generic truthiness conversion.
- **Normalize once and use one effective password.** Supply original text to the SDK,
  trim and URI-component encode it once, and use the same effective password and salt
  for stream hashing, room hashing and SDP/ICE encryption. Room joins, retries and
  reconnects must not encode it again. Refresh cached hashes after a supported override.
- **Check both encrypted and disabled paths.** With a password, use the reference
  AES-256-CBC format and fresh random IVs in `vector`. Encryption failure must stop
  the send, never fall back to plaintext. With protection explicitly disabled, send
  plain JSON SDP/ICE without `vector` and use unhashed stream/room IDs. DTLS-SRTP,
  SCTP over DTLS and WSS still apply; the shared default is not a private secret.

### Retries, limits and cancellation

- **Let one SDK recovery loop own retries.** Do not add tight `connect`, `joinroom`,
  `seed` or `play` loops around it. Keep one pending retry per stream and bound queues;
  repeated discovery notifications must not multiply connection attempts or timers.
- **Preserve the JS reference pacing.** Signaling reconnects default to five attempts,
  starting at 1 second with exponential backoff capped at 30 seconds. The regular
  unavailable-stream retry interval is 15 minutes. A short retry used by a specific
  recovery path is not permission to poll an absent publisher every few seconds.
  These are client defaults, not server quotas or guaranteed allowances.
- **Respect service limits.** Treat throttling, capacity errors and exhausted retries
  as failures to handle, not reasons to increase request frequency. Do not open more
  sockets, rotate identities, reset attempt counters or reconnect repeatedly to bypass
  limits. Server queue/drain constants are not a client request-rate budget. Use local
  servers for burst, outage and load tests; agree higher hosted-service limits separately.
- **Cancel before replay.** Explicit disconnect/stop must remove the relevant intent,
  timers and pending waits. Late callbacks must not resurrect it. On an unexpected
  signaling reconnect, replay only current intent in room → publish → view order,
  without duplicate offers, old ICE or re-sanitized passwords. Do not reset healthy
  peer connections merely to refresh discovery information.

### Tests to require when these paths change

These are acceptance criteria, not a claim that every port already has every test.
Adapt the existing JS regressions and shared vectors; use local fixtures for failures
and pacing, and a controlled native-browser run for interoperability.

| Check | Required assertion |
| --- | --- |
| WebSocket boundary | Capture outbound traffic through setup, use and shutdown; reject unexpected fields/shapes and any application payload, greeting or bye fallback. |
| Room-status integration | Exercise the status/list-users UI or wrapper with a spy/fake SDK; it must not join/list/disconnect or poll handshake rooms to obtain a roster. Review examples for the same anti-pattern. |
| Retry pacing | With fake time and a failing local endpoint, assert delay progression, attempt limits, one timer per stream and no request burst after repeated discovery events. |
| Stop/reconnect races | Disconnect during hashing, room setup, ICE or a retry; late completion must not send, reopen or restore stopped intent. |
| Password matrix | Cover omitted/null/empty/whitespace, disabled, literal keywords, supported numeric/boolean inputs, Unicode/percent text, default/custom/empty salt, joins and reconnects. |
| Encryption failures | Assert no plaintext fallback on encryption failure, no negotiation after a wrong password/salt, and no IV or hashed IDs in disabled mode. |
| Native URL parsing | Feed generated links through VDO.Ninja's parser; preserve keyword literals, prompting/default distinctions, salt and the complete signaling endpoint. |
| Data-first handshake | Assert initial data-only negotiation → open control channel → native `info`/preferences exchange → media negotiation. Reject early media, missing information exchange and custom greeting/acknowledgement messages. |
| SDP/ICE sequencing | Assert correct offerer/answerer, session/direction matching, early candidate handling and stale candidate rejection. |
| Media scope | Verify one audio track and one primary video track, including audio-only/video-only preferences; do not infer extra-track roles or support from an engine accepting them. |
| Real media and teardown | Verify decoded video and audible audio in both directions, late publisher arrival, viewer close/replacement, retained preferences, native bye and finalized playable recordings. |

Existing starting points: [JS review tests](../tests/sdk-review.test.js),
[JS cancellation tests](../tests/sdk-reconnect-cancellation.test.js),
[shared vectors](../spec/vectors.json),
[native protocol guards](../python/tests/test_native_protocol_contract.py),
[reference-server tests](../python/tests/test_reference_server.py),
[native URL tests](../tests/interop/native-inputs.test.cjs) and
[Rust/native-browser A/V tests](../tests/interop/rust-av-live.cjs).
Record which engines, password modes and failure paths actually ran; a local server
accepting a message or a data channel opening alone does not establish native A/V compatibility.

### Known data-first implementation gap

The current JS SDK `_createOffer` and Rust SDK `create_offer` add publisher media
tracks to the initial offer. They create the control channel first, but do not wait
for it to open and exchange `info` before negotiating media. Publisher `info` is
also conditional on configured fields. These paths therefore do not yet meet the
data-first rule above. The existing Rust live test expects media in that first
offer: its passing result proves A/V interoperability, not this ordering contract.
Track these as implementation/test gaps, not permitted exceptions or a reason to
copy the behavior into further ports. This documentation change does not alter
the JS SDK or claim those gaps have been fixed.

## Password inputs

Constructor options and browser URL parameters have different input semantics:

| Input | SDK constructor | VDO.Ninja URL |
| --- | --- | --- |
| Omitted | Shared default `someEncryptionKey123` | Shared site default |
| Null / absent optional string | Shared default | URLs have no null type |
| Empty string | Shared default | `?password=` prompts for a password |
| Whitespace string | Shared default after trimming | Native URL processing trims after testing disable keywords; do not use whitespace to select the default |
| Boolean `false` / explicit no-password option | No password hashing or SDP/ICE encryption | `?password=false`, `?password=0`, `?password=off`, or `?nopassword` disables it |
| String `"false"`, `"0"`, `"off"` | Literal password; hashing/encryption enabled | Unescaped values disable it; literal values require escaping described below |

Rust, Go, C, Kotlin, Swift and Dart accept typed password strings with a separate
`no_password` / `NoPassword` / `noPassword` flag. Python accepts `password=False`.
JS and Python also accept boolean `true` and numeric `0`, coercing them to the
literal strings `"true"` and `"0"`; typed ports should receive those strings.
Do not coerce a string disable keyword to a boolean in an SDK wrapper.

The Rust demo emits `password=%2566alse`, `password=%2530`, or `password=%256Fff`
for those three literal passwords. URL parsing removes one escape level;
`main.js` checks disable keywords, then calls `decodeURIComponent` before
sanitizing the password. `--no-password` instead emits `password=false`.
The link tests execute these native source branches, including the prompt case.

Pass original password text into SDK options. It is trimmed and URI-component
encoded once. Salt is appended to that sanitized value for both hashing and the
AES key derivation. Omitted/empty salt selects `vdo.ninja`; a custom salt must
match on both peers. The shared default still enables encryption, but is public.
Disabling the password sends plain JSON SDP/ICE without `vector` and uses raw
stream/room IDs. WebRTC DTLS-SRTP, SCTP over DTLS, and WSS remain in use.

Room operations inherit the existing password when no override is provided;
they must not encode it again. Python `None` and Rust `None` mean inherit for
these operations. Python `False` disables it; Python/Rust explicit empty strings
reset the default. C's null password pointer inherits, while an explicit empty
string resets the default. Go's zero-value `JoinOptions.Password` means inherit; use
constructor options to select the desired mode before joining. Mobile ports
configure password mode on the instance.

`spec/vectors.json` includes 33 constructor password/salt cases generated by the
unchanged JS SDK. Every native port consumes those cases in its tests. The optional
Python reference-server tests additionally route hashed room/stream IDs and
encrypted or plaintext offers through an unmodified `hss/gemini.js` process:

```bash
cd python
VDONINJA_REFERENCE_HOST=ws://127.0.0.1:8443 pytest -q tests/test_reference_server.py
```

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
