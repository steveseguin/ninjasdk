# VDO.Ninja SDK for Kotlin and Java (Android)

Two Gradle modules:

| Module | What it is | Depends on |
| --- | --- | --- |
| `vdoninja-core` | The VDO.Ninja protocol without WebRTC: hashing, AES-CBC signaling encryption, ID sanitization, the signaling socket with reconnect, TURN selection, options and events. Pure JVM (Android or desktop Java); tested against `spec/vectors.json`. | OkHttp, `org.json` (provided by Android) |
| `vdoninja-android` | The SDK: publishing, viewing, data channels, pub/sub and request/response on Google's libwebrtc, packaged by [Stream](https://github.com/GetStream/webrtc-android) (`io.getstream:stream-webrtc-android`). | `vdoninja-core`, libwebrtc |

Same protocol as the JavaScript SDK and the other native SDKs: an Android app can publish to and view from browsers
running VDO.Ninja and interoperate with the Go, Rust, C, Python and Flutter SDKs. Kotlin-first with `@JvmOverloads`
and `@JvmStatic` so the API is natural from Java.

License: MPL-2.0 (same as the SDK core). libwebrtc is BSD-3-Clause, OkHttp Apache-2.0.

## Install

Until artifacts are published, include the modules as a composite build or copy them into your project:

```kotlin
// settings.gradle.kts
includeBuild("path/to/ninjasdk/kotlin")
// build.gradle.kts
dependencies { implementation("ninja.vdo.sdk:vdoninja-android") }
```

Requirements: minSdk 24, Java 17, AGP 8.9+. Add camera/microphone permissions to your manifest when publishing media.

## Quick start (Kotlin)

```kotlin
val vdo = VdoNinja(context, VdoNinjaOptions(password = "mysecret", label = "Phone"))
vdo.addListener { e ->
    when (e.type) {
        VdoEvents.DATA_RECEIVED -> Log.d("vdo", "${e.uuid}: ${e.data}")
        VdoEvents.TRACK -> (e.track as? VideoTrack)?.addSink(remoteRenderer)   // SurfaceViewRenderer
    }
}

// Blocking calls: run off the main thread (coroutines Dispatchers.IO, an executor, ...)
thread {
    vdo.connect()

    // Publish camera + microphone using libwebrtc's own capture classes
    val factory = vdo.factory
    val audio = factory.createAudioTrack("mic", factory.createAudioSource(MediaConstraints()))
    val videoSource = factory.createVideoSource(false)
    val capturer = Camera2Enumerator(context).run { createCapturer(deviceNames.first { isFrontFacing(it) }, null) }
    capturer.initialize(SurfaceTextureHelper.create("cam", vdo.eglBase.eglBaseContext), context, videoSource.capturerObserver)
    capturer.startCapture(1280, 720, 30)
    val video = factory.createVideoTrack("cam", videoSource)
    val streamId = vdo.publish(listOf(audio, video), streamId = "my-phone", room = "myroom")
    // viewers: https://vdo.ninja/?view=my-phone&room=myroom&password=mysecret

    // View someone else (blocks until the offer arrives)
    val conn = vdo.view("their-stream")
    vdo.sendData(JSONObject().put("hello", "world"))          // every peer
    vdo.sendData(JSONObject().put("hi", true), uuid = conn?.uuid)
}
```

Data-only peers call `announce()` instead of `publish()`. `autoConnect(room)` joins, announces and views every other
member (half mesh). `view()` throws `TimeoutException` when the publisher is not online yet; the request stays pending
and connects when the stream appears (`timeoutMs = 0` returns immediately).

## API overview

| Area | Members |
| --- | --- |
| Events | `addListener`/`removeListener` (`VdoEventListener`), `on(type) { }`; names in `VdoEvents` match the JavaScript SDK; delivered on libwebrtc/OkHttp threads |
| Lifecycle | `connect()`, `disconnect()`, `dispose()`, `connected`, `factory`, `eglBase` |
| Rooms | `joinRoom(room, claim, timeoutMs)` → listing, `leaveRoom()`, `currentRoom` |
| Publishing | `announce()`, `publish(tracks, streamId, room)`, `addTrack()`, `replaceTrack()` (camera switch), `stopPublishing()` |
| Viewing | `view(streamId, ViewOptions(audio, video, label), timeoutMs)`, `stopViewing()`, `autoConnect(room, streamId, fullMode)`; media arrives as `TRACK` events with an `org.webrtc.MediaStreamTrack` |
| Data | `sendData(data, uuid, type, preference, allowFallback)`, `sendPing()` → `PEER_LATENCY` |
| Pub/sub | `subscribe()`, `unsubscribe()`, `publishToChannel()` → `CHANNEL_MESSAGE` |
| RPC | `onRequest(type) { data, from -> }`, `request(type, data, uuid)` (blocking), `respond()` |
| Introspection | `peers()`, `connection(uuid, type)` (exposes the `PeerConnection`), `streams()` |

Options (`VdoNinjaOptions`): `host`, `room`, `password`/`noPassword`, `salt`, `label`, `metaJson`, `turnMode`
(AUTO/DISABLED/CUSTOM with `turnServers`), `forceTurn`, `forceTcp`, `stunServers`, reconnect and timeout tuning,
`autoPingViewer`, `debug` (logcat tag `vdoninja`).

Not included, by design: file transfer, resources, `x-` channel helpers, WHIP/WHEP, recording, screen capture. Use
`connection(uuid).pc` for anything else libwebrtc offers.

## Build and test

```bash
cd kotlin
./gradlew :vdoninja-core:test                  # protocol conformance (spec/vectors.json), no Android SDK needed
ANDROID_HOME=~/Android/Sdk ./gradlew :vdoninja-android:assembleRelease
```

The Android module is only included when an Android SDK is configured (`ANDROID_HOME` or `local.properties`). For
offline testing run the local signaling server from any other SDK and set `host = "ws://<lan-ip>:8080"`.

## Hosted service notice

Use of the signaling, TURN and related services operated by Steve Seguin is subject to the applicable Terms of Service
and operational policies. This SDK is the supported way to use them; only WebRTC handshake data is allowed through the
signaling server, and application data must travel over peer-to-peer channels. Self-hosting is covered by
[websocket_server](https://github.com/steveseguin/websocket_server).
