# VDO.Ninja SDK for Swift (iOS, macOS, tvOS)

A Swift package with two products:

| Product | What it is | Depends on |
| --- | --- | --- |
| `VDONinjaCore` | The VDO.Ninja protocol without WebRTC: SHA-256 and AES-CBC (pure Swift, no dependencies), ID sanitization, the signaling socket (`URLSessionWebSocketTask`) with reconnect, TURN selection, options and events. Builds on Apple platforms and Linux; tested against `spec/vectors.json`. | Foundation |
| `VDONinja` | The SDK: publishing, viewing, data channels, pub/sub and request/response on Google's WebRTC, via the [stasel/WebRTC](https://github.com/stasel/WebRTC) binary package. Apple platforms only. | `VDONinjaCore`, WebRTC |

Same protocol as the JavaScript SDK and the other native SDKs: an iOS or macOS app can publish to and view from
browsers running VDO.Ninja and interoperate with the Go, Rust, C, Python, Flutter and Android SDKs.

License: MPL-2.0 (same as the SDK core). WebRTC is BSD-3-Clause.

## Install

```swift
// Package.swift
.package(url: "https://github.com/steveseguin/ninjasdk.git", branch: "main"),
// target dependencies
.product(name: "VDONinja", package: "ninjasdk"),   // path: swift/
```

Or add `swift/` as a local package in Xcode. Add `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` to
your Info.plist when publishing media.

## Quick start

```swift
import VDONinja
import WebRTC

var options = VDONinjaOptions(password: "mysecret", label: "iPhone")
let vdo = VDONinja(options: options)

vdo.on(.dataReceived) { e in print("\(e.uuid ?? "?"): \(e.data ?? "")") }
vdo.on(.track) { e in
    if let video = e.track as? RTCVideoTrack { DispatchQueue.main.async { video.add(remoteView) } } // RTCMTLVideoView
}

try await vdo.connect()

// Publish camera + microphone using WebRTC's own capture classes
let audio = vdo.factory.audioTrack(with: vdo.factory.audioSource(with: nil), trackId: "mic")
let source = vdo.factory.videoSource()
let capturer = RTCCameraVideoCapturer(delegate: source)
// pick a device/format and call capturer.startCapture(with:format:fps:)
let video = vdo.factory.videoTrack(with: source, trackId: "cam")
let streamId = try await vdo.publish(tracks: [audio, video], streamId: "my-iphone", room: "myroom")
// viewers: https://vdo.ninja/?view=my-iphone&room=myroom&password=mysecret

// View someone else
let conn = try await vdo.view("their-stream")
vdo.sendData(["hello": "world"])                       // every peer
vdo.sendData(["hi": true], uuid: conn?.uuid)            // one peer
let answer = try await vdo.request("whoami", ["q": 1], to: conn!.uuid)

await vdo.disconnect()
```

Every operation has both an `async` form and a completion-handler form. Events arrive on the SDK's serial queue;
hop to the main thread for UI. Data-only peers call `announce()` instead of `publish()`. `autoConnect(room:)`
joins, announces and views every other member (half mesh). `view()` throws `SDKError.timeout` when the publisher
is not online yet; the request stays pending and connects when the stream appears.

## API overview

| Area | Members |
| --- | --- |
| Events | `addListener { }`, `on(.type) { }`, `removeListener(token)`; `VDOEventType` cases match the JavaScript SDK names |
| Lifecycle | `connect()`, `disconnect()`, `connected`, `factory`, `queue` |
| Rooms | `joinRoom(room, claim:)` → listing, `leaveRoom()`, `currentRoom` |
| Publishing | `announce()`, `publish(tracks:streamId:room:)`, `addTrack()`, `replaceTrack()` (camera switch), `stopPublishing()` |
| Viewing | `view(streamId, options: ViewOptions(audio:video:label:))`, `stopViewing()`, `autoConnect(room:streamId:fullMode:)`; media arrives as `.track` events with an `RTCMediaStreamTrack` |
| Data | `sendData(data, uuid:type:preference:allowFallback:)`, `sendPing()` → `.peerLatency` |
| Pub/sub | `subscribe()`, `unsubscribe()`, `publishToChannel()` → `.channelMessage` |
| RPC | `onRequest(type) { data, from in }`, `request(type, data, to:)`, `respond()` |
| Introspection | `peers()`, `connection(uuid, type:)` (exposes the `RTCPeerConnection`), `streams()` |

Options (`VDONinjaOptions`): `host`, `room`, `password`/`noPassword`, `salt`, `label`, `meta`, `turnMode`
(`.auto`/`.disabled`/`.custom` with `turnServers`), `forceTurn`, `forceTcp`, `stunServers`, reconnect and timeout
tuning, `autoPingViewer`, `debug`.

Not included, by design: file transfer, resources, `x-` channel helpers, WHIP/WHEP, recording, ReplayKit screen
capture. Use `connection(uuid)?.pc` for anything else WebRTC offers.

## Build and test

```bash
cd swift
swift build          # core on Linux; core + SDK on macOS
swift test           # protocol conformance (spec/vectors.json)
```

For offline testing run the local signaling server from any other SDK and set `host` to `ws://<lan-ip>:8080`.

## Hosted service notice

Use of the signaling, TURN and related services operated by Steve Seguin is subject to the applicable Terms of Service
and operational policies. This SDK is the supported way to use them; only WebRTC handshake data is allowed through the
signaling server, and application data must travel over peer-to-peer channels. Self-hosting is covered by
[websocket_server](https://github.com/steveseguin/websocket_server).
