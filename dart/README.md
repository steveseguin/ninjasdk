# VDO.Ninja SDK for Dart and Flutter

Two packages:

| Package | What it is | Depends on |
| --- | --- | --- |
| [`vdoninja_core`](vdoninja_core/) | The VDO.Ninja protocol without WebRTC: hashing, AES-CBC signaling encryption, ID sanitization, the signaling socket with reconnect, TURN selection, options and events. Pure Dart; runs on the VM and the web; tested against `spec/vectors.json`. | `crypto`, `pointycastle`, `web_socket_channel`, `http` |
| [`vdoninja`](vdoninja/) | The SDK: publishing, viewing, data channels, pub/sub and request/response on top of [flutter_webrtc](https://pub.dev/packages/flutter_webrtc). Android, iOS, macOS, Windows, Linux and web. | `flutter_webrtc`, `vdoninja_core` |

It implements the same protocol as the JavaScript SDK and the other native SDKs in this repository, so a Flutter app
can publish to and view from browsers running VDO.Ninja and interoperate with the Go, Rust, C and Python SDKs.

License: MPL-2.0 (same as the SDK core). Examples are MIT. flutter_webrtc is MIT.

## Install

Until the packages are published, reference them by path or git:

```yaml
dependencies:
  vdoninja:
    git:
      url: https://github.com/steveseguin/ninjasdk.git
      path: dart/vdoninja
```

flutter_webrtc needs the usual platform setup (camera and microphone permissions in `AndroidManifest.xml` and
`Info.plist`); see its README.

## Quick start

```dart
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:vdoninja/vdoninja.dart';

final vdo = VdoNinja(const VdoNinjaOptions(password: 'mysecret', label: 'Phone'));

// Publish the camera and microphone
await vdo.connect();
final stream = await navigator.mediaDevices.getUserMedia({'audio': true, 'video': true});
final streamId = await vdo.publish(stream, streamId: 'my-phone', room: 'myroom');
// viewers: https://vdo.ninja/?view=my-phone&room=myroom&password=mysecret

// View someone else
vdo.on(VdoEvents.track, (e) {
  final renderer = RTCVideoRenderer(); // from flutter_webrtc
  renderer.initialize().then((_) => renderer.srcObject = e.stream as MediaStream?);
});
final conn = await vdo.view('their-stream');

// Data
vdo.on(VdoEvents.dataReceived, (e) => print('${e.uuid}: ${e.data}'));
vdo.sendData({'hello': 'world'});                  // every peer
vdo.sendData({'hello': 'you'}, uuid: conn.uuid);   // one peer

await vdo.disconnect();
```

Data-only peers use `announce()` instead of `publish()`. `autoConnect(room)` joins a room, announces and views every
other member (half mesh). `view()` throws a `TimeoutException` when the publisher is not online yet; the request stays
pending and connects when the stream appears.

## API overview

| Area | Members |
| --- | --- |
| Events | `events` (broadcast `Stream<VdoEvent>`), `on(type, handler)`, `waitFor(type)`; names in `VdoEvents` match the JavaScript SDK |
| Lifecycle | `connect()`, `disconnect()`, `dispose()`, `connected` |
| Rooms | `joinRoom(room:, claim:)` → listing, `leaveRoom()`, `room` |
| Publishing | `announce(streamId:, room:)`, `publish(MediaStream, streamId:, room:)`, `addTrack()`, `replaceTrack()` (camera switch), `stopPublishing()` |
| Viewing | `view(streamId, options: ViewOptions(audio:, video:, label:))`, `stopViewing()`, `autoConnect(room, fullMode:)` ; media arrives as `track` events with `track` and `stream` |
| Data | `sendData(data, uuid:, type:, preference:, allowFallback:)`, `sendPing()` → `peerLatency` |
| Pub/sub | `subscribe(channels)`, `unsubscribe()`, `publishToChannel(channel, data)` → `channelMessage` |
| RPC | `onRequest(type, handler)`, `request(type, data, uuid)`, `respond()` |
| Introspection | `peers`, `connection(uuid, type)` (exposes the `RTCPeerConnection`), `streams` |

Options (`VdoNinjaOptions`): `host`, `room`, `password`/`noPassword`, `salt`, `label`, `meta`, `turnMode`
(auto/disabled/custom with `turnServers`), `forceTurn`, `forceTcp`, `stunServers`, reconnect and timeout tuning,
`autoPingViewer`, `debug`.

Not included, by design: file transfer, resources, `x-` channel helpers, WHIP/WHEP, recording. Use the Go, Rust, C or
Python SDKs for those server-side features, or add them on top of `connection(uuid).pc`.

## Tests

```bash
cd dart/vdoninja_core && dart pub get && dart test     # protocol conformance (spec/vectors.json)
cd dart/vdoninja && flutter pub get && flutter analyze  # engine layer
```

The engine layer needs a device or emulator to run; use the local signaling server from any other SDK
(`go run ./cmd/vdoninja-signal`, `vdoninja-signal`, `python -m vdoninja.signalserver`) and point `host` at
`ws://<lan-ip>:8080` for offline testing.

## Hosted service notice

Use of the signaling, TURN and related services operated by Steve Seguin is subject to the applicable Terms of Service
and operational policies. This SDK is the supported way to use them; only WebRTC handshake data is allowed through the
signaling server, and application data must travel over peer-to-peer channels. Self-hosting is covered by
[websocket_server](https://github.com/steveseguin/websocket_server).
