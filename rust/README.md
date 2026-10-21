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

[`examples/av.rs`](vdoninja/examples/av.rs) publishes a looping 640×360/30 fps
VP8 test pattern and a 440 Hz Opus tone, receives a browser stream to files, or
does both at once. Install FFmpeg with `libvpx` and `libopus` for publishing;
receiving needs only the Rust executable.

From this directory:

```bash
# Optional private password. Use original text, without URL escaping.
export VDONINJA_PASSWORD='choose your own secret'

# Publish test audio/video. Open the WATCH URL printed by the demo.
cargo run --example av -- --publish my_rust_camera

# Receive browser audio/video. Open the PUBLISH FROM BROWSER URL printed.
cargo run --example av -- --view my_browser_camera --out received

# Both directions, in the same room.
cargo run --example av -- \
  --publish my_rust_camera --view my_browser_camera --room my_test_room --out received
```

Use unique stream/room names. With no arguments the demo generates a random
publish ID. `--seconds 30` stops automatically; `--host wss://…` selects a
different signaling server. The printed browser URLs include matching signaling,
room, codec and password settings (and therefore contain the password when set).
If the browser publisher starts later, the demo keeps its view request pending
and retries. Allow camera/microphone access in the browser; click the page if
autoplay needs a gesture.

Use **one viewing peer** for this demo. The current webrtc-rs sample track has
one binding; attaching it to another peer redirects its output. The generated
browser publisher link includes an empty `view` parameter so it does not subscribe to
the Rust stream automatically when joining the room. Open the separate WATCH
link to receive the Rust stream. Multi-viewer sample-track fan-out is not
implemented by this example.

Incoming Opus is saved as OGG, and VP8/VP9 as IVF, with separate filenames for
each track/reconnection. The example requests periodic keyframes and reports
packet counts. Play the files after stopping with `ffplay received/<file>.ogg`
or `ffplay received/<file>.ivf`. This is a basic RTP recorder, not a synchronized
A/V player or muxer: IVF playback assumes 30 fps with 640×360 header hints;
the decoder obtains actual dimensions from the bitstream. Other codecs and
loss-tolerant recording need a suitable media pipeline.

The demo uses the SDK's normal VDO.Ninja handshake, matching the JS SDK:

1. Connect to WSS and announce the publisher (`seed`); a viewer requests `play`.
2. On `offerSDP`, the publisher creates the ordered `sendChannel` **before**
   creating its SDP offer. The Rust publisher includes its media tracks in that
   offer, as the JS SDK does.
3. Exchange encrypted SDP and trickled ICE with the peer UUID/session. The viewer
   answers the publisher; it does not create a competing offer or control channel.
4. Once `sendChannel` opens, the viewer sends `{audio:true, video:true}`.
   Native VDO.Ninja publishers can then add media through a subsequent offer
   over that channel. This demo uses only native control messages (including
   ping/pong); it sends no custom application payloads or metadata.
5. Ctrl-C, SIGTERM (Unix), a timed stop, or a fatal demo error stops producers,
   calls `disconnect()` to send `{bye:true}` and drain control buffers before
   closing WebRTC/signaling, then joins recording tasks and finalizes their files.

Passwords use the existing VDO.Ninja AES-256-CBC SDP/ICE protocol with random IVs
and the `vdo.ninja` salt. Media uses DTLS-SRTP and data channels use SCTP over
DTLS; WSS protects the signaling transport. This does not enable the browser's
optional insertable-stream media encryption. Omitting `VDONINJA_PASSWORD` uses
the SDK's shared default password, not a private secret.

For a real-browser interoperability check (requires Playwright/Chromium and
FFmpeg), run from the repository root:

```bash
npm ci
cargo build --manifest-path rust/Cargo.toml --example av
node tests/interop/rust-av-live.cjs
```

`PLAYWRIGHT_MODULE` can point to an existing Playwright installation.
The test exchanges real audio/video with `https://vdo.ninja/`, checks encrypted
SDP/ICE, DTLS/SRTP, native ping/pong and bye delivery, and decodes finalized
recordings with FFmpeg. A test-only loopback WebSocket observer checks every
Rust outbound message against the existing JS SDK signaling shapes before
forwarding its unchanged bytes to the hosted WSS server. It also decrypts and
validates SDP/ICE and checks that an initial offer follows `offerSDP` and includes
the control channel. Media, ping/pong, media preferences and bye never use the
signaling socket in this test. `VDO_TEST_URL` selects another native VDO.Ninja build.

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
