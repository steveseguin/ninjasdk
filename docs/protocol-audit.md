# Protocol audit: 2026-11-08

The source of truth is the [VDO.Ninja application at `3ea79516`](https://github.com/steveseguin/vdo.ninja/tree/3ea79516ff9f96108bff10cffd33fa5fe95a00de).
The JavaScript SDK, native SDKs, their local signaling servers and their generated vectors are implementations and test aids, not specifications.

## Validated issues and remedies

| Finding | Change |
| --- | --- |
| C, Go, Python, Rust, Dart, Kotlin and Swift exposed a local identity option and added `from` without implementing fan-out mode. | Removed `client_id`, `ClientID` and `clientId`, including their allocations and send-path injection. JavaScript rejects those unsupported constructor options. |
| All eight SDKs implemented `__fallback` signaling messages for application data, although the browser's signaling receiver has no matching handler. | Removed the send/receive extension, `allowFallback` / `AllowFallback` / `allow_fallback` and obsolete event flags. Generic application data waits for WebRTC. |
| JavaScript comments reversed the meaning of outgoing `UUID`. | Documented destination on send and server-supplied sender on delivery. |
| SDK-generated vectors and SDK-to-SDK interoperability were described as protocol authority. | Relabeled them as consistency tests and added independent browser-source checks and wire auditing. |
| Pub/sub, RPC and `x-bin` were mixed into the description of native browser functionality. | Identified them as SDK application conventions using the browser's supported extension mechanisms. |
| Local signaling fixtures could hide incorrect client fields by stripping them. | Audit outbound frames before fixture processing, and deliberately add a conflicting `from` to server replies. |

The VST plugin's vendored JavaScript SDK receives the same corrections. Its native `play` requests also drop `audio`/`video`: those preferences belong on `sendChannel` after connection, not in discovery signaling.

## Source evidence

- [`main.js` URL setup](https://github.com/steveseguin/vdo.ninja/blob/3ea79516ff9f96108bff10cffd33fa5fe95a00de/main.js#L7621): `wss` enables `customWSS`; `wss2` changes the endpoint without enabling it.
- [`webrtc.js` `sendMsg`](https://github.com/steveseguin/vdo.ninja/blob/3ea79516ff9f96108bff10cffd33fa5fe95a00de/webrtc.js#L6798) and [receive normalization](https://github.com/steveseguin/vdo.ninja/blob/3ea79516ff9f96108bff10cffd33fa5fe95a00de/webrtc.js#L7728): `from` is added/interpreted in `customWSS` mode only.
- [`sendGenericData`](https://github.com/steveseguin/vdo.ninja/blob/3ea79516ff9f96108bff10cffd33fa5fe95a00de/webrtc.js#L3451): wraps application data in `pipe` and uses WebRTC send helpers.
- [`watch` discovery](https://github.com/steveseguin/vdo.ninja/blob/3ea79516ff9f96108bff10cffd33fa5fe95a00de/webrtc.js#L6661): `play` carries `streamID`; audio/video preferences follow on the data channel.
- [`isReservedChannelLabel`](https://github.com/steveseguin/vdo.ninja/blob/3ea79516ff9f96108bff10cffd33fa5fe95a00de/webrtc.js#L877): `x-` is explicitly reserved for third-party channels, which the browser ignores. `x-bin` is an SDK convention within that reservation.

Custom SDK `host` URLs still use server-routed signaling. These SDKs do not implement the browser's `&wss` fan-out mode. Local logging, timeouts, buffering, WebRTC engine selection and connection routing preferences are SDK controls; they are not transmitted as extra VDO.Ninja protocol fields.

## Migration

Remove the deleted identity and signaling-fallback options from application configuration. Rebuild native applications: removing C struct members changes its ABI. Wait for `dataChannelOpen` before sending application data; a send without an available data channel reports failure. JavaScript and Python reject unknown data-target options rather than silently accepting obsolete ones.

SDK pub/sub and RPC remain application payloads inside `pipe`. A plain VDO.Ninja browser does not execute those SDK conventions. Ordinary application payloads may contain arbitrary field names; the protocol allowlist applies to the outer envelope, not user data.

The `social_ninja` Android app was not modified. Its preference for `from` over server-routed `UUID` remains a separate follow-up for the app maintainer; behavior should be conditional on an explicitly implemented fan-out mode.

## Regression checks

- `npm run test:protocol` checks emitted SDK messages, removed APIs and unknown outer fields, while preserving arbitrary `pipe` payloads.
- `npm run test:protocol:source` executes `sendMsg` and `sendGenericData` from a separate VDO.Ninja checkout. Set `VDON_REFERENCE_SOURCE` if it is not `../vdo.ninja`. CI pins the reviewed source revision.
- `spec/signaling-contract.json` records the reviewed signaling subset. It is a test allowlist, not a replacement specification. New supported messages require browser-source evidence and corresponding tests.
- Python integration tests inspect client messages before local-server processing and deliver a conflicting `from` beside the authoritative `UUID`.
- The cross-language interop runner uses the same audit via a transparent proxy. Unknown fields fail the run, even for an otherwise known failing engine pair.
- Existing C, Go, Rust and mobile core tests still verify their own lifecycle and shared-vector behavior. Passing these alone does not prove compatibility with every browser feature.

This audit covers signaling identities, request/control envelopes, application-data transport and their documentation. It does not claim every SDK implements every feature in the VDO.Ninja application.

## Initial audit validation

- C: build and all 3 native suites passed.
- Go: all package tests passed.
- Rust: workspace unit, integration, vector and documentation tests passed.
- Python: all 19 tests passed, including audited signaling with conflicting incoming `from` fields.
- JavaScript: 80 reliability/contract tests passed; one optional external-server-source test skipped. TypeScript and all 14 generated-guide checks passed.
- Browser source: both independent function checks passed against the pinned VDO.Ninja checkout.
- Cross-language signaling audit: all 13 tested pairings passed (the 4 JavaScript/Python pairs and the 9 Go/C/Rust pairs). This was not the complete five-language matrix.
- Dart core: analyzer and all 10 tests passed. Kotlin core: all 14 tests passed.
- VST: Windows build, vendored-SDK tests, 9 receive scenarios and the 6-case native receive matrix passed. These include data-before-media, conflicting incoming `from`, native mic-only, video-bearing offers, forced TURN and a TURN-discovery outage.

The subsequent CI validation below includes Swift and the Flutter/Android/Apple WebRTC wrappers. SDK packages have not been published.

## Follow-up correctness review

Each correction below was checked against the browser implementation or the actual transport library. SDK configuration and local retry scheduling are not additional wire protocol fields.

| Finding | Correction and focused validation |
| --- | --- |
| 1. Publishers attached audio/video before control preferences. | All SDKs and the VST now offer `sendChannel` first. Boolean audio/video preferences enable tracks and a later media offer; an omitted preference preserves the previous choice. Real transport tests cover JS, C, Go, Python, Rust and the plugin. Flutter, Android and Apple wrapper builds passed in CI. |
| 2. VST data-channel ICE could use a payload UUID to create or target another peer. | Bind offers, answers and ICE to the channel owner, matching webrtc.js receiveChannel.onmessage. Destination-UUID regression tests cover encrypted browser and plugin-to-plugin renegotiation. |
| 3. Non-ASCII AES bytes differed from the browser. | Use each UTF-16 code unit's low byte for AES keys and plaintext, and Latin-1 decoding. Hashes remain UTF-8. Execute the real browser conversion in vector tests, including an emoji salt and Latin-1 plaintext. |
| 4. VST encryption failure could send plaintext. | Fail closed. A separate native test process forces OpenSSL RNG failure and observes no plaintext SDP/ICE. |
| 5. Relay timezone selection used inconsistent signs or DST rules. | Match `lib.js:getTimezone`, including its historical 1900/1906 baseline. Winter/summer tests execute browser code. Windows C runtimes without pre-1970 dates use the OS standard offset; rare historical timezone differences remain a limitation there. |
| 6. Backup relay lists drifted. | Generate all eight SDK lists and the plugin's list from the reviewed `webrtc.js` source; CI detects drift. Test discovery failure and selected relay URLs independently of the SDK. |
| 7. Long-lived clients retained expired relay credentials. | Refresh automatic discovery caches and coalesce concurrent lookups. The plugin refreshes its instance even while signaling stays connected. Deterministic expiry/outage tests verify credential rotation. |
| 8. C advertised unsupported forced TCP relay. | Reject `force_tcp` with `EINVAL` and select supported UDP relays. The current C/plugin libjuice backend does not provide TURN TCP/TLS. |
| 9. Documentation overstated Python forced-relay support. | Separate TURN discovery from an enforced relay-only policy; aiortc does not expose that policy here. |
| 10. VST recovery dropped throttled requests and could stall after disconnect. | Retain retry intent through outages; expire stalled initial/disconnected peers; use existing `play`, offers, `ping`/`pong` and `iceRestartRequest`. Ignore retired-session messages. UDP proxy tests cover repeated IP/port changes, complete packet blackouts, encrypted room reconnects, delayed offers, source outages and cancellation. |
| 11. Python asynchronous work could outlive disconnect. | Check connection generation after awaits and before sending; cancellation regression tests cover late work. |
| 12. VST ignored WHEP restart markers at the same URL. | Match the browser's `started` marker identity and replace the WHEP resource when it changes. Test both control-channel and encrypted signaling delivery. |
| 13. Custom TURN discovery URLs lost existing queries. | Preserve encoded, repeated and empty query values in Python, Go, Rust, Dart, Kotlin and Swift URL construction. Test owned HTTP endpoints or captured requests. |
| 14. JS TURN timeout ended after headers. | Keep the timeout active through body parsing. An owned server stalls its body and the request times out. |
| 15. Envelope guards accepted invalid nested values. | Validate SDP, ICE, session and encrypted-field shapes; keep opaque application payloads unrestricted. Shared invalid vectors exercise the plugin and SDK test guards. |

The browser recovery reference is [`webrtc.js` connection-state handling](https://github.com/steveseguin/vdo.ninja/blob/3ea79516ff9f96108bff10cffd33fa5fe95a00de/webrtc.js#L23518). The plugin's libjuice backend explicitly rejects ICE restart, so it recovers with a fresh publisher session through the existing negotiation flow. Healthy media survives signaling reconnects. A peer that has never answered a control ping is not disconnected for ignoring pings; it uses ICE state and connection deadlines instead.

Follow-up local results include C's three suites, Go's race-enabled package tests, 29 Python tests, Dart core analysis and 11 tests, the six browser-source checks, and BrowserStack Samsung Galaxy S23 / Android 13 Chrome publishing through the unmodified browser checkout into the plugin (received RMS 0.166392). Repeated VST IP changes recovered measured audio in about nine seconds; an older-app fixture without pong support took about 30 seconds. These are controlled test results, not a guarantee for every mobile network.

Android remains unchanged. In the reviewed `social_ninja` source, incoming default signaling prefers `from` at `signaling.dart:5402`, and `_handleDataChannelMessage` at `signaling.dart:12683` lacks the browser's ping/pong handling. Use routed `UUID` outside explicit fan-out mode and echo a control ping's token on that same channel. Review its existing ICE-restart/session guards when applying those app fixes; no new wire identity is needed.

## Completed branch validation

[Native SDK CI](https://github.com/steveseguin/ninjasdk/actions/runs/42543274997) passed all twelve jobs: C, Go with the race detector, Rust on Linux/macOS/Windows, Python 3.10/3.12, Dart/Flutter, Kotlin/Android, Swift on macOS and Linux, and cross-language interop. [JavaScript CI](https://github.com/steveseguin/ninjasdk/actions/runs/42543277607) passed both WebRTC engines on Node 18 and 20. These runs validate commit `82bf101`; integrating subsequent upstream changes requires another run.

Real Chrome against the unmodified browser checkout passed encrypted media, special-character password and application-data interoperability. The plugin passed Chrome audio in both directions, owned encrypted live-room audio and destination-UUID media renegotiation.

## Integration with current main

Commit `3b80181` combines the audit with the newer upstream native SDK fixes, preserving the initial `info` exchange, one primary track per media kind, cancellable discovery, password-mode behavior and Go SDP serialization. [Native CI](https://github.com/steveseguin/ninjasdk/actions/runs/42545011410) passed all twelve jobs, including cross-language interop. [JavaScript CI](https://github.com/steveseguin/ninjasdk/actions/runs/42545014134) passed all four Node/engine combinations. Focused merge validation also passed Go race tests, Python tests, all 24 documentation/protocol/source checks and Rust formatting. SDK package publication remains separate from these repository changes.
