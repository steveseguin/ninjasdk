# VDO.Ninja SDK for Go

[![Go Reference](https://pkg.go.dev/badge/github.com/steveseguin/ninjasdk/go.svg)](https://pkg.go.dev/github.com/steveseguin/ninjasdk/go)

Go implementation of the VDO.Ninja SDK, built on [pion/webrtc](https://github.com/pion/webrtc). It speaks the same wire protocol as the [JavaScript SDK](../README.md) and VDO.Ninja browser pages, so a Go process can publish to, view, message and exchange files with any VDO.Ninja peer.

Typical uses: headless recorders and media bots, server-side bridges (RTP/RTSP/SRT in, VDO.Ninja out), chat/control backends, CLI tools, and a single-binary local signaling server for LAN or offline deployments.

License: MPL-2.0 (same as the SDK core). Examples are MIT. pion/webrtc is MIT.

## Install

```bash
go get github.com/steveseguin/ninjasdk/go
```

Requires Go 1.22+. No cgo, no native dependencies; cross-compiles to Linux, macOS, Windows, ARM.

## Data channel quick start

```go
package main

import (
	"context"
	"log"
	"time"

	vdoninja "github.com/steveseguin/ninjasdk/go"
)

func main() {
	sdk := vdoninja.New(vdoninja.Options{Salt: "vdo.ninja"})
	sdk.On(vdoninja.EventDataReceived, func(ev vdoninja.Event) {
		log.Printf("from %s: %v", ev.UUID, ev.Data)
	})
	sdk.On(vdoninja.EventDataChannelOpen, func(ev vdoninja.Event) {
		sdk.SendDataTo(ev.UUID, map[string]any{"message": "Hello from Go"})
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ctl, err := sdk.AutoConnect(ctx, vdoninja.AutoConnectOptions{Room: "replace_with_a_unique_room"})
	if err != nil {
		log.Fatal(err)
	}
	defer ctl.Stop()
	select {}
}
```

Run the same program twice, or pair it with the JavaScript `autoConnect` demo in the same room.

## Publish media

Local tracks are pion `TrackLocal` values. `TrackLocalStaticSample` takes encoded frames (VP8/VP9/H264/AV1/Opus); `TrackLocalStaticRTP` forwards RTP packets you already have (for example from GStreamer or FFmpeg over UDP).

```go
video, _ := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "cam")
audio, _ := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "cam")

sdk := vdoninja.New(vdoninja.Options{Password: "my secret", Salt: "vdo.ninja"})
sdk.Connect(ctx)
streamID, err := sdk.Publish(ctx, []webrtc.TrackLocal{video, audio}, vdoninja.PublishOptions{
	StreamID: "gocam", Room: "myroom", Label: "Go camera",
})
// Open https://vdo.ninja/?view=gocam&room=myroom&scene&password=my%2520secret
```

See [`examples/publish-file`](examples/publish-file/main.go) for IVF/OGG playback with the viewer URL printed, and [`examples/whip-publish`](examples/whip-publish/main.go) for WHIP.

## View media

```go
sdk.On(vdoninja.EventTrack, func(ev vdoninja.Event) {
	go func() {
		for {
			pkt, _, err := ev.Track.ReadRTP()
			if err != nil { return }
			// write pkt to a file, forward it, decode it ...
		}
	}()
})
sdk.Connect(ctx)
sdk.JoinRoom(ctx, "myroom")
conn, err := sdk.View(ctx, "gocam")
```

`View` returns `ErrStreamNotYetAvailable` when the publisher is not there yet; the request stays pending and connects automatically once the stream appears. [`examples/record`](examples/record/main.go) writes IVF/OGG files.

## API overview

| Area | Methods |
| --- | --- |
| Lifecycle | `New`, `Connect`, `Disconnect`, `Connected`, `On`, `OnAny` |
| Rooms | `JoinRoom`, `LeaveRoom`, `Room`, `Streams`, `Peers`, `Connection` |
| Publishing | `Publish`, `Announce`, `AddTrack`, `StopPublishing`, `StreamID` |
| Viewing | `View`, `StopViewing` |
| Data | `SendData`, `SendDataTo`, `SendDataWith` (`DataTarget`), `SendPing` |
| Pub/Sub | `Subscribe`, `Unsubscribe`, `PublishToChannel`, `Subscriptions`, `PeerSubscriptions` |
| RPC | `Request`, `OnRequest`, `Respond` |
| Binary | `OpenChannel` (reserved `x-` labels), `SendBinary`, `BufferedAmount` |
| Files | `HostFile`, `HostReader`, `UnhostFile`, `HostedFiles`, `RequestFile` |
| Resources | `SendResource` |
| Mesh | `AutoConnect` (`half` or `full` mode) |
| Diagnostics | `Stats`, `PeerQualityOf`, `ClearTURNCache` |
| WHIP/WHEP | `NewWHIPClient`, `NewWHEPClient` |

Events carry the same names as the JavaScript SDK (`dataReceived`, `peerInfo`, `peerLatency`, `fileList`, `track`, `listing`, `videoaddedtoroom`, ...). Handlers run on SDK goroutines; hand off blocking work.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `Host` | `wss://wss.vdo.ninja` | Signaling server. Use your own with `vdoninja-signal` or websocket_server. |
| `Password` / `NoPassword` | shared default | Original text; the SDK URL-encodes once before hashing. `NoPassword` disables encryption (JS `password: false`). |
| `Salt` | `vdo.ninja` | Must match the viewer's domain salt. |
| `TURN` | `TURNAuto` | `TURNDisabled` or `TURNCustom` with `TURNServers`. `ForceTURN` requests relay-only. |
| `STUNServers` | Google + Cloudflare | Empty slice disables STUN. |
| `API` | default pion API | Supply a `webrtc.API` with your own `MediaEngine`/`SettingEngine` (codec selection, port ranges, loopback candidates). |
| `AutoPingViewer` | off | Viewer pings every `AutoPingInterval`; two misses trigger an ICE restart request. |
| `ClientID` | unset | Adds a `from` field for the legacy fan-out signaling servers. |

Reconnection: after an unexpected socket loss the SDK reconnects with exponential backoff (`MaxReconnectAttempts`, `ReconnectDelay`) and replays the room join, publish/announce and pending views.

## Local signaling server

`cmd/vdoninja-signal` is a single-binary implementation of the routed signaling protocol used by `wss2=`:

```bash
go run ./cmd/vdoninja-signal -addr :8080
# SDKs: Options{Host: "ws://127.0.0.1:8080"}
# Browser: https://vdo.ninja/?view=x&wss2=127.0.0.1:8080  (use TLS + -cert/-key for https pages)
```

It is used by the test suite and is suitable for LAN, CI and offline work. It does not provide TURN or rate limiting.

## Tests

```bash
go test ./...          # protocol vectors + end-to-end tests over the local server
go test -race ./...
```

The protocol vectors in [`../spec/vectors.json`](../spec/vectors.json) are generated from the JavaScript SDK, so hashing, encryption and sanitization cannot drift from the reference implementation.

## Hosted service notice

Use of the signaling, TURN and related services operated by Steve Seguin is subject to the applicable Terms of Service and operational policies. This SDK is the supported way to use them; only WebRTC handshake data is allowed through the signaling server, and application data must travel over peer-to-peer channels. Self-hosting is covered by [websocket_server](https://github.com/steveseguin/websocket_server) and [offline_deployment](https://github.com/steveseguin/offline_deployment).
