# VDO.Ninja SDK for Rust

Signaling uses the existing VDO.Ninja protocol. Application data and native `ping`/`pong`/`bye` messages use peer data channels; there is no WebSocket application-data fallback or client-supplied `from` field. Wait for the control channel to open before sending data.

Pub/sub and request/response helpers preserve the JS SDK application protocol inside native `pipe` messages. They require a compatible SDK/application at the other end; the VDO.Ninja page forwards generic `pipe` data to its embedding application and does not implement those helpers itself.

Leaving a room disconnects its peers and signaling socket: the handshake server has no `leave` command. Reconnect before joining another room or publishing again. Await the leave operation in asynchronous APIs (Rust, Python, Dart and Swift).

[![crates.io](https://img.shields.io/crates/v/vdoninja.svg)](https://crates.io/crates/vdoninja)

Rust implementation of the VDO.Ninja SDK, built on [webrtc-rs](https://webrtc.rs) 0.21 (the sans-I/O `rtc` core with a tokio driver) and `rustls`. It speaks the same wire protocol as the [JavaScript SDK](../README.md) and VDO.Ninja browser pages, so a Rust program can publish to, view, message and exchange files with any VDO.Ninja peer.

Linux is the primary target: no native WebRTC library to install, no OpenSSL dependency, static single-binary deploys on x86-64 and ARM (Raspberry Pi, embedded boards, servers). macOS and Windows also build.

Two crates:

| Crate | Contents | License |
| --- | --- | --- |
| [`vdoninja-core`](vdoninja-core) | Engine-agnostic protocol core: hashing, AES-CBC signaling encryption, sanitization, TURN selection, wire types. No async runtime, no WebRTC dependency. Reuse it with GStreamer `webrtcbin`, `str0m` or any other engine. | MPL-2.0 |
| [`vdoninja`](vdoninja) | The full SDK on webrtc-rs + tokio, a local signaling server, WHIP/WHEP clients (MIT) and examples (MIT). | MPL-2.0 |

## Install

```toml
[dependencies]
vdoninja = "0.1"
tokio = { version = "1", features = ["full"] }
serde_json = "1"
```

Rust 1.85+ (edition 2024 dependencies).

## Data channel quick start

```rust
use vdoninja::{Event, Options, VdoNinja};

#[tokio::main]
async fn main() -> vdoninja::Result<()> {
    let sdk = VdoNinja::new(Options { salt: "vdo.ninja".into(), ..Default::default() });
    let mut events = sdk.events();
    let ctl = sdk.auto_connect("replace_with_a_unique_room", Default::default()).await?;
    while let Ok(ev) = events.recv().await {
        match ev {
            Event::DataChannelOpen { uuid, .. } => {
                sdk.send_ping(&uuid).await;
            }
            Event::DataReceived { uuid, data, .. } => println!("{uuid}: {data}"),
            _ => {}
        }
    }
    ctl.stop();
    Ok(())
}
```

Run it twice, or pair it with the JavaScript `autoConnect` demo in the same room.

## Publish media

### Runnable audio/video demo

[`examples/av.rs`](vdoninja/examples/av.rs) publishes a VP8 test pattern and Opus
tone, receives a browser stream to files, or does both. Publishing requires FFmpeg
with `libvpx` and `libopus`; receiving needs only the Rust executable.

From this directory:

```bash
# Optional private password; pass original text.
export VDONINJA_PASSWORD='choose your own secret'

# Open the printed WATCH link.
cargo run --example av -- --publish my_unique_camera

# Open the printed PUBLISH FROM BROWSER link.
cargo run --example av -- --view my_unique_browser --out received

# Both directions.
cargo run --example av -- --publish my_unique_camera --view my_unique_browser --out received
```

Use unique IDs and allow browser camera/microphone access. The demo supports one
viewing peer at a time; closing and replacing it leaves publishing and recording
running. Ctrl-C sends native bye and finalizes Opus OGG and VP8/VP9 IVF files.
This is a basic recorder, not a synchronized A/V player; IVF playback uses 30 fps
and 640×360 header hints. Play completed files with FFplay.

`--seconds 30` stops automatically. `--room`, `--host`, `--salt` and
`--no-password` select matching connection settings. For a local `ws://` observer,
`--browser-host` supplies its browser-accessible WSS endpoint. Printed links
preserve the endpoint path/query and contain the password when set.

Follow the [SDK checklist](../docs/native-sdks.md#sdk-integration-checklist).
The code establishes the control channel and exchanges native information and
preferences before adding media. The [browser test](../tests/interop/rust-av-live.cjs)
checks that ordering, A/V in both directions, viewer replacement and shutdown:

```bash
# From the repository root; requires Playwright/Chromium and FFmpeg.
cargo build --manifest-path rust/Cargo.toml --example av
node tests/interop/rust-av-live.cjs
```

`vdoninja::media::SampleTrack` wraps a webrtc-rs `TrackLocalStaticSample` with the codec's SSRC and payload type so encoded frames (VP8/VP9/H264/AV1/Opus) can be written with one call. Any `Arc<dyn TrackLocal>` works too, for example `TrackLocalStaticRTP` to forward RTP from GStreamer or FFmpeg.

```rust
use vdoninja::media::SampleTrack;
use vdoninja::{Options, PublishOptions, VdoNinja};

let video = SampleTrack::new("video/VP8", "cam", "video")?;
let sdk = VdoNinja::new(Options { password: Some("my secret".into()), ..Default::default() });
sdk.connect().await?;
sdk.publish(vec![video.local()], PublishOptions { stream_id: Some("rscam".into()), room: Some("myroom".into()), ..Default::default() }).await?;
// Open https://vdo.ninja/?view=rscam&room=myroom&scene&password=my%2520secret
video.write(encoded_frame, std::time::Duration::from_millis(33)).await?;
```

See [`examples/publish_file.rs`](vdoninja/examples/publish_file.rs) for IVF/OGG playback and [`examples/record.rs`](vdoninja/examples/record.rs) for writing a viewed stream to disk.

## View media

```rust
match ev {
    Event::Track { track, .. } => {
        tokio::spawn(async move {
            while let Some(ev) = track.poll().await {
                if let TrackRemoteEvent::OnRtpPacket(packet) = ev { /* write, forward, decode */ }
            }
        });
    }
    _ => {}
}
sdk.connect().await?;
sdk.join_room("myroom").await?;
let conn = sdk.view("rscam", ViewOptions::default()).await?;
```

`view` returns `Error::StreamNotYetAvailable` when the publisher is not there yet; the request stays pending and connects automatically once the stream appears.

## API overview

| Area | Methods on `VdoNinja` |
| --- | --- |
| Lifecycle | `new`, `connect`, `disconnect`, `connected`, `events` |
| Rooms | `join_room`, `join_room_with`, `leave_room`, `room`, `streams`, `peers`, `connection` |
| Publishing | `publish`, `announce`, `stop_publishing`, `stream_id` |
| Viewing | `view`, `stop_viewing` |
| Data | `send_data`, `send_data_to`, `send_data_with` (`DataTarget`), `send_ping` |
| Pub/Sub | `subscribe`, `unsubscribe`, `publish_to_channel`, `subscriptions`, `peer_subscriptions` |
| RPC | `request`, `on_request`, `respond` |
| Binary | `open_channel` (reserved `x-` labels), `send_binary` |
| Files | `host_file`, `unhost_file`, `hosted_files`, `request_file` |
| Resources | `send_resource` |
| Mesh | `auto_connect` (`half` or `full` mode) |
| WHIP/WHEP | `whip::WhipClient`, `whip::WhepClient` |

Events are an enum received from a `tokio::sync::broadcast` channel; variant names follow the JavaScript SDK events (`DataReceived`, `PeerInfo`, `PeerLatency`, `FileList`, `Track`, `Listing`, `VideoAddedToRoom`, ...). `Event::name()` returns the JavaScript name.

## Options

| Field | Default | Notes |
| --- | --- | --- |
| `host` | `wss://wss.vdo.ninja` | Signaling server. Run your own with `vdoninja-signal`. |
| `password` / `no_password` | shared default | Original text; `no_password` disables hashing and encryption (JS `password: false`). |
| `salt` | `vdo.ninja` | Must match the viewer's domain salt. |
| `turn` | `TurnMode::Auto` | `Disabled` or `Custom(Vec<IceServer>)`. `force_turn` requests relay-only. |
| `stun_servers` | Google + Cloudflare | Empty disables STUN. |
| `bind_addrs` | `["0.0.0.0:0"]` | Local UDP bind addresses; the wildcard expands to all interfaces. `include_loopback` adds `127.0.0.1` candidates (tests). |
| `auto_ping_viewer` | off | Viewer pings every `auto_ping_interval`; two misses trigger an ICE restart request. |

Reconnection: after an unexpected socket loss the SDK reconnects with exponential backoff and replays the room join, publish/announce and pending views.

## Platforms and engine choice

The crate is pure Rust: webrtc-rs, rustls and ring, no system WebRTC library and no OpenSSL. It builds and runs on
Linux (x86-64, ARM), macOS and Windows with a plain `cargo build`; CI runs the test suite on all three. Linux
remains the primary target (static binaries for servers, Raspberry Pi and embedded boards), but nothing in the SDK is
platform-specific.

The engine is deliberately a single backend. Alternatives were weighed against "minimal dependencies":

| Backend | Trade-off |
| --- | --- |
| webrtc-rs (current) | Pure Rust, cross-platform, data channels and media, no native toolchain beyond a C compiler for ring. Missing ICE restart; 16 KiB inbound data channel messages. |
| libdatachannel via the `datachannel` crate | Adds a C++17 build of libdatachannel, OpenSSL/mbedTLS and usrsctp; gains ICE restart but makes cross-compiling and static Linux builds much harder. |
| str0m (sans-IO) | Pure Rust and lean, but the SDK would have to supply the whole socket/timer loop and media is still maturing. |

Swapping the backend would mean reimplementing `sdk.rs`'s peer-connection layer; the protocol core
(`vdoninja-core`) is engine-independent and would be reused as is.

## webrtc-rs notes

- Incoming data channel messages are limited to 16384 bytes by webrtc-rs 0.21; VDO.Ninja's file transfer uses that chunk size, so files work, but split large `send_binary` payloads.
- Viewer audio/video preferences are applied by removing and re-adding senders with a renegotiation offer (webrtc-rs has no `replaceTrack(null)`).
- Statistics are available through `Connection::peer_connection().get_stats(..)`.
- The SDK answers offers as the DTLS server so that the offerer initiates the SCTP association (the rtc crate only initiates it as the DTLS client). One combination remains unsupported: a Rust publisher viewed by the Python SDK (aiortc initiates SCTP only when ICE-controlling, so with Rust offering neither side does). Browsers, Go, C and Python publishing to Rust all work.

## Local signaling server

```bash
cargo run --bin vdoninja-signal -- 0.0.0.0:8080
# SDK: Options { host: "ws://127.0.0.1:8080".into(), .. }
# Browser: https://vdo.ninja/?view=x&wss2=127.0.0.1:8080  (TLS needed for https pages)
```

The same server is used by the test suite (`vdoninja::signalserver::SignalServer`).

## Tests

```bash
cargo test            # vdoninja-core vectors + vdoninja end-to-end tests over the local server
```

The protocol vectors in [`../spec/vectors.json`](../spec/vectors.json) are generated from the JavaScript SDK, so hashing, encryption and sanitization cannot drift from the reference implementation.

## Hosted service notice

Use of the signaling, TURN and related services operated by Steve Seguin is subject to the applicable Terms of Service and operational policies. This SDK is the supported way to use them; only WebRTC handshake data is allowed through the signaling server, and application data must travel over peer-to-peer channels.
