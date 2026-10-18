# VDO.Ninja SDK for C

A C99 implementation of the VDO.Ninja SDK built on [libdatachannel](https://github.com/paullouisageneau/libdatachannel)
(MPL-2.0). It speaks the same signaling protocol, hashing and encryption as the JavaScript SDK, so a C program can
publish to and view from browsers running VDO.Ninja, and interoperate with the Go, Rust and Python SDKs in this
repository.

Intended for embedded devices, encoders, OBS-style tools and anything that already produces or consumes RTP.

License: MPL-2.0 for the SDK (`include/`, `src/`), MIT for the examples. cJSON (MIT) is vendored under
`third_party/`. Conformance vectors shared with the other SDKs live in `../spec/vectors.json`.

## Build

Requirements: CMake 3.16+, a C99 compiler, a C++17 compiler (for libdatachannel), OpenSSL. libcurl is optional and
enables fetching the hosted TURN list (a built-in list is used otherwise).

```bash
cmake -S c -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

By default libdatachannel v0.23.2 is downloaded with FetchContent and linked statically. To use a system install
instead, make `find_package(LibDataChannel)` succeed (for example `-DCMAKE_PREFIX_PATH=/usr/local`) or disable the
download with `-DVDON_FETCH_LIBDATACHANNEL=OFF`.

Targets: `libvdoninja.a` (or `-DVDON_BUILD_SHARED=ON`), `vdoninja-signal` (a local signaling server), the examples
`vdon_chat`, `vdon_publish_rtp`, `vdon_view_rtp`, and the tests `vdon_test_vectors` and `vdon_test_e2e`.

Linux is the primary target. The code is plain POSIX threads plus libdatachannel; Windows builds need pthreads
(e.g. pthreads-win32 or MSYS2) and `bcrypt` for random numbers.

## Quick start: data channels

```c
#include <vdoninja.h>
#include <stdio.h>

static void on_event(vdon_sdk *sdk, const vdon_event *ev, void *user) {
    if (ev->type == VDON_EVENT_DATA_RECEIVED)
        printf("%s says %s\n", ev->uuid, ev->json);
    else if (ev->type == VDON_EVENT_DATA_CHANNEL_OPEN)
        vdon_send_data(sdk, "{\"hello\":\"world\"}", ev->uuid);
}

int main(void) {
    vdon_options o;
    vdon_sdk *sdk;
    char stream_id[64];
    vdon_options_init(&o);
    o.password = "mysecret";              /* NULL = shared default, o.no_password = 1 disables encryption */
    sdk = vdon_create(&o, on_event, NULL);
    if (vdon_connect(sdk, 10000) != VDON_OK) return 1;
    vdon_announce(sdk, "my-c-stream", NULL, stream_id, sizeof stream_id);   /* data-only publisher */
    /* ... a browser opens https://vdo.ninja/?view=my-c-stream&password=mysecret ... */
    getchar();
    vdon_destroy(sdk);
    return 0;
}
```

Viewing side: `vdon_view(sdk, "their-stream", NULL, 10000)` returns `VDON_OK` once the publisher's offer has
arrived, or `VDON_ERR_PENDING` when the publisher is not online yet (the request stays pending and connects when the
stream appears). `vdon_auto_connect()` joins a room, announces, and views every other member (half mesh by default).

Events are delivered on libdatachannel's threads. The SDK lock is not held during callbacks, so any SDK function can
be called from a callback, but pointers in `vdon_event` are only valid during the call. Do not call `vdon_destroy`
from a callback.

## Media

The SDK does not encode or decode. It moves RTP.

Publishing: describe tracks with `vdon_track_init` and call `vdon_publish()`. Every viewer gets its own peer
connection with its own tracks.

* `packetize = 0`: feed complete RTP packets from your encoder or an `rtpsink` with `vdon_send_rtp()`. The
  SSRC and payload type must match the track description. This is the path for GStreamer/ffmpeg pipelines and
  hardware encoders (see `examples/publish_rtp.c`).
* `packetize = 1`: feed encoded frames with `vdon_send_sample()`; libdatachannel packetizes H.264, H.265, AV1,
  Opus, PCMU, PCMA and G.722 and adds RTCP sender reports and NACK handling.

Viewer PLI requests surface as `VDON_EVENT_KEYFRAME_REQUEST`; tell your encoder to emit a keyframe. Viewers that
turn video or audio off via the control channel stop receiving packets for that kind automatically.

Viewing: after `vdon_view()`, each incoming media section emits `VDON_EVENT_TRACK` (with the SDP media description
in `ev->message`) and then one `VDON_EVENT_RTP` per packet with `ev->bytes`/`ev->size`. Forward them to a decoder or
UDP socket (see `examples/view_rtp.c`). `vdon_request_keyframe()` sends a PLI.

## API overview

| Area | Functions |
| --- | --- |
| Lifecycle | `vdon_create`, `vdon_connect`, `vdon_disconnect`, `vdon_destroy`, `vdon_is_connected` |
| Rooms | `vdon_join_room`, `vdon_leave_room`, `vdon_room` |
| Publishing | `vdon_announce` (data only), `vdon_publish`, `vdon_send_rtp`, `vdon_send_sample`, `vdon_stop_publishing` |
| Viewing | `vdon_view`, `vdon_stop_viewing`, `vdon_request_keyframe`, `vdon_auto_connect` |
| Data | `vdon_send_data`, `vdon_send_data_ex` (target by UUID/type/preference, optional signaling fallback), `vdon_send_ping` |
| Pub/sub | `vdon_subscribe`, `vdon_unsubscribe`, `vdon_publish_to_channel` |
| RPC | `vdon_on_request`, `vdon_request` (blocking, with timeout), `vdon_respond` |
| Binary | `vdon_send_binary` (reserved `x-bin` lane), `vdon_open_channel` (any `x-` channel, returns a libdatachannel id) |
| Files | `vdon_host_file`, `vdon_unhost_file`, `vdon_request_file`; resources from VDO.Ninja arrive as `VDON_EVENT_RESOURCE_RECEIVED` |
| Introspection | `vdon_peers_json`, `vdon_streams_json`, `vdon_peer_connection` (libdatachannel pc id, usable with the `rtc*` API) |
| Protocol helpers | `vdon_generate_hash`, `vdon_sanitize_*`, `vdon_encrypt_message`, `vdon_decrypt_message` |
| Local signaling | `vdon_signal_server_create`, `vdon_signal_server_port`, `vdon_signal_server_destroy` |

All functions return `VDON_OK` (0) or a negative `VDON_ERR_*` code; `vdon_strerror()` names them. Strings returned
through `char **` are malloc'd and freed with `vdon_free()`.

### Options

`vdon_options_init()` sets the defaults (`wss://wss.vdo.ninja`, default password, salt `vdo.ninja`, 5 reconnect
attempts with doubling delay, 20 s connection timeout). Notable fields:

* `password` / `no_password`: the password hashes stream and room IDs and encrypts SDP and ICE, exactly like the
  JavaScript SDK. `no_password = 1` mirrors `password: false`.
* `turn_mode`: `VDON_TURN_AUTO` (hosted list, closest two UDP and one TCP relay; built-in list when offline or when
  libcurl is absent), `VDON_TURN_DISABLED`, or `VDON_TURN_CUSTOM` with `turn_servers` in libdatachannel form
  `turn:user:pass@host:3478`. `force_turn` makes ICE relay-only.
* `stun_servers`: NULL for Google and Cloudflare STUN; a non-NULL pointer with `stun_server_count = 0` disables STUN
  (useful on a LAN).
* `label` / `meta_json`: publisher info sent to viewers on the control channel.
* `auto_ping_viewer`: viewer-side keepalive pings; two missed replies drop and re-request the stream.
* `debug`: log signaling and control-channel traffic to stderr.

## Local signaling server

`vdoninja-signal [port]` runs a VDO.Ninja-compatible routed signaling server (the "wss2" protocol) for LAN, offline
and test use. Point the SDKs at `ws://host:port`; browsers use `https://vdo.ninja/?wss2=host:port` (which needs
TLS, see the Go server's `-cert`/`-key` options). The same server is embedded in the test suite.

## Engine notes

* libdatachannel does not implement ICE restart; a failed connection is torn down and, for viewers, re-requested
  from the publisher (`VDON_EVENT_CONNECTION_FAILED` is emitted).
* libjuice (the ICE agent) supports TURN over UDP only; `turns:` and TCP relays in the hosted list are ignored.
* Incoming messages larger than the SCTP receive limit (default 256 KiB) are dropped by libdatachannel; the file
  transfer protocol uses 16 KiB chunks and is unaffected.
* Data channels opened by peers with labels other than `sendChannel`, `x-*`, `resources` or `chunked` are treated as
  file transfers, matching VDO.Ninja.

## Tests

`vdon_test_vectors` checks hashing, encryption and sanitization against `spec/vectors.json`; `vdon_test_e2e` runs
two SDK instances against the embedded signaling server and exercises data, RPC, pub/sub, binary, file transfer,
RTP forwarding with PLI, the no-password mode, pending views and half-mesh autoConnect. Run with `-v` for a trace.

## Hosted service notice

The SDK defaults to Steve Seguin's hosted signaling (`wss.vdo.ninja`) and TURN servers. Using them is subject to
the VDO.Ninja Terms of Service: only WebRTC handshake data may pass through the signaling server, and application
data must go over peer connections. Using these SDKs as intended is the supported way to access the service; talking
to the hosted servers with custom clients requires permission. For anything else, host your own signaling server
([websocket_server](https://github.com/steveseguin/websocket_server)) or use the built-in one.
