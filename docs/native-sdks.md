# Native SDKs

Basic connectors for publishing/receiving audio/video and sending peer data.
Use one audio track and one primary video track as the interoperability baseline.
The SDK is not a replacement for the VDO.Ninja application.

| Language | Code and runnable examples |
| --- | --- |
| Rust | [Rust SDK](../rust/README.md) · [audio/video demo](../rust/vdoninja/examples/av.rs) |
| Go | [Go SDK](../go/README.md) |
| C | [C SDK](../c/README.md) |
| Python | [Python SDK](../python/README.md) |
| Dart / Flutter | [Flutter SDK](../dart/README.md) |
| Kotlin / Java | [Android SDK](../kotlin/README.md) |
| Swift | [Swift SDK](../swift/README.md) |

## Basic audio/video demo

Install FFmpeg for the test publisher, then run from the repository root:

```bash
# Publish a test pattern and tone; open the printed WATCH link.
cargo run --manifest-path rust/Cargo.toml --example av -- --publish my_unique_camera

# Receive browser audio/video to files; open the printed PUBLISH FROM BROWSER link.
cargo run --manifest-path rust/Cargo.toml --example av -- --view my_unique_browser --out received

# Both directions.
cargo run --manifest-path rust/Cargo.toml --example av -- --publish my_unique_camera --view my_unique_browser --out received
```

Use unique IDs. Allow camera/microphone access in the browser. Ctrl-C sends native
bye and finalizes recordings. This example supports one viewing peer at a time;
closing and replacing that viewer leaves publishing and recording running.

## SDK integration checklist

- Establish the data connection first. Exchange native `info` and preferences on
  the open control channel before negotiating media. Legacy no-data-channel paths
  are outside SDK scope.
- Match existing message shapes, types, peer/session IDs and offer ownership.
  No custom greetings, goodbye messages, fields or handshake acknowledgements.
- Use the handshake WebSocket only for supported SDK signaling. No application
  data, media, files, telemetry or application-data fallback. Use peer data channels.
- Never join a room, collect its listing and disconnect solely to enumerate users;
  do not poll that sequence. For page/room status integrations, use the documented
  [VDO.Ninja `?api` option](https://docs.vdo.ninja/advanced-settings/api-and-midi-parameters/api)
  or [iframe interface](https://docs.vdo.ninja/guides/iframe-api-documentation).
- Keep one cancellable retry per stream. Preserve bounded reconnect backoff and
  the normal unavailable-stream retry interval; do not add tight polling loops,
  duplicate sockets or counter resets to bypass limits. Stop/disconnect must cancel
  retries and prevent late callbacks from restoring stopped intent.
- Preserve native bye delivery and cleanup. The handshake server has no room
  `leave` request. Native ports leave by closing their signaling connection.
- Keep default, disabled and literal passwords distinct. Follow the implementation
  and [shared test cases](../spec/vectors.json), not truthiness conversions.
- Test actual audio/video in both directions. An open data channel alone is not
  a media test. Do not infer extra-track support from an engine accepting track arrays.

## Password inputs

Pass original password text to SDK options. Omitted/empty SDK passwords use the
shared default; only an explicit disable option disables password protection.
SDK strings `"false"`, `"0"` and `"off"` are literal passwords, while those ordinary
browser URL values disable protection. An empty browser password parameter prompts.
Use the generated demo links, and keep salt and the complete signaling endpoint
consistent on both peers. Do not encode passwords again during join/reconnect.

For the Rust demo, `VDONINJA_PASSWORD` sets the password, `--no-password` explicitly
disables password protection, and `--salt` selects the salt. Printed private-password
links contain the password. The shared default is not a private secret.

## Code and tests

The implementation is authoritative. Check the JS SDK together with the relevant
VDO.Ninja handler and `hss/gemini.js`; server acceptance alone does not establish
correct usage. Do not copy behavior that violates the handshake checklist.

| Check | Starting point |
| --- | --- |
| JS reference and regressions | [SDK](../vdoninja-sdk.js), [review tests](../tests/sdk-review.test.js), [cancellation tests](../tests/sdk-reconnect-cancellation.test.js) |
| Password inputs and native browser links | [shared cases](../spec/vectors.json), [URL tests](../tests/interop/native-inputs.test.cjs) |
| Signaling boundaries and actual server routing | [protocol guards](../python/tests/test_native_protocol_contract.py), [Gemini tests](../python/tests/test_reference_server.py) |
| Data-first handshake, A/V, viewer replacement and bye | [Rust browser test](../tests/interop/rust-av-live.cjs), [native integration tests](../rust/vdoninja/tests/integration.rs) |
| Retry deduplication and cancellation | [Rust tests](../rust/vdoninja/src/sdk.rs), [Go tests](../go/sdk_test.go), [Python tests](../python/tests/test_sdk.py), [C tests](../c/tests/test_review.c) |

Use local fixtures for retry/failure tests. Report unavailable engine coverage;
do not claim that an SDK-to-SDK test proves native-browser compatibility.
See [test commands](../tests/interop/README.md) and each port's README.

## License and hosted services

SDK core code is MPL-2.0; see [LICENSING.md](../LICENSING.md). Hosted services have
separate usage rules and limits. Use the SDK's supported signaling paths.
