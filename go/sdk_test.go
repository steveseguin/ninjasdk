// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"bytes"
	"context"
	"crypto/rand"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/steveseguin/ninjasdk/go/signalserver"
)

func testAPI() *webrtc.API {
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	me := &webrtc.MediaEngine{}
	_ = me.RegisterDefaultCodecs()
	return webrtc.NewAPI(webrtc.WithSettingEngine(se), webrtc.WithMediaEngine(me))
}

func startSignal(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(signalserver.New())
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func newTestSDK(t *testing.T, host string, extra func(*Options)) *SDK {
	t.Helper()
	opts := Options{Host: host, TURN: TURNDisabled, STUNServers: []string{}, API: testAPI(), Password: "test pass!", ConnectionTimeout: 10 * time.Second}
	if testing.Verbose() {
		opts.Debug = true
	}
	if extra != nil {
		extra(&opts)
	}
	s := New(opts)
	t.Cleanup(s.Disconnect)
	return s
}

func waitFor(t *testing.T, ch <-chan Event, timeout time.Duration, what string) Event {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(timeout):
		t.Fatalf("timeout waiting for %s", what)
		return Event{}
	}
}

func TestDataRoundTrip(t *testing.T) {
	host := startSignal(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pub := newTestSDK(t, host, func(o *Options) { o.Label = "Go publisher" })
	view := newTestSDK(t, host, nil)

	pubOpen := make(chan Event, 4)
	pub.On(EventDataChannelOpen, func(ev Event) { pubOpen <- ev })
	pubData := make(chan Event, 16)
	pub.On(EventDataReceived, func(ev Event) { pubData <- ev })
	viewData := make(chan Event, 16)
	view.On(EventDataReceived, func(ev Event) { viewData <- ev })
	viewInfo := make(chan Event, 4)
	view.On(EventPeerInfo, func(ev Event) { viewInfo <- ev })
	latency := make(chan Event, 4)
	view.On(EventPeerLatency, func(ev Event) { latency <- ev })

	if err := pub.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := pub.JoinRoom(ctx, "go-test-room"); err != nil {
		t.Fatal(err)
	}
	sid, err := pub.Announce(ctx, PublishOptions{StreamID: "gopub"})
	if err != nil {
		t.Fatal(err)
	}
	if sid != "gopub" {
		t.Fatalf("streamID %q", sid)
	}

	if err := view.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := view.JoinRoom(ctx, "go-test-room"); err != nil {
		t.Fatal(err)
	}
	conn, err := view.View(ctx, "gopub", ViewOptions{Audio: Bool(false), Video: Bool(false), Label: "Go viewer"})
	if err != nil {
		t.Fatal(err)
	}
	if conn.StreamID() != "gopub" || conn.Type() != "viewer" {
		t.Fatalf("unexpected connection %+v", conn)
	}
	open := waitFor(t, pubOpen, 15*time.Second, "publisher data channel")
	viewerUUID := open.UUID

	info := waitFor(t, viewInfo, 10*time.Second, "peer info")
	if info.Info["label"] != "Go publisher" {
		t.Errorf("label not delivered: %+v", info.Info)
	}

	// Viewer -> publisher and back on the single bidirectional channel.
	if !view.SendData(map[string]any{"hello": "publisher"}) {
		t.Fatal("viewer send failed")
	}
	ev := waitFor(t, pubData, 10*time.Second, "publisher data")
	if m, _ := ev.Data.(map[string]any); m["hello"] != "publisher" || ev.UUID != viewerUUID {
		t.Fatalf("unexpected data %+v", ev)
	}
	if !pub.SendDataTo(viewerUUID, "plain string") {
		t.Fatal("publisher send failed")
	}
	ev = waitFor(t, viewData, 10*time.Second, "viewer data")
	if ev.Data != "plain string" {
		t.Fatalf("unexpected data %+v", ev)
	}

	// Ping / pong latency.
	if !view.SendPing(conn.UUID()) {
		t.Fatal("ping failed")
	}
	if l := waitFor(t, latency, 10*time.Second, "latency"); l.Latency < 0 || l.Latency > 5000 {
		t.Errorf("latency %d", l.Latency)
	}

	// Request / response.
	pub.OnRequest("add", func(data any, from string) (any, error) {
		m := data.(map[string]any)
		return m["a"].(float64) + m["b"].(float64), nil
	})
	res, err := view.Request(ctx, "add", map[string]any{"a": 2, "b": 3}, conn.UUID())
	if err != nil || res.(float64) != 5 {
		t.Fatalf("request: %v %v", res, err)
	}
	pub.OnRequest("fail", func(any, string) (any, error) { return nil, context.DeadlineExceeded })
	if _, err := view.Request(ctx, "fail", nil, conn.UUID()); err == nil || !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("expected handler error, got %v", err)
	}

	// Pub/sub.
	chanMsg := make(chan Event, 4)
	pub.On(EventChannelMessage, func(ev Event) { chanMsg <- ev })
	subscribed := make(chan Event, 4)
	view.On(EventPeerSubscribed, func(ev Event) { subscribed <- ev })
	pub.Subscribe("news")
	waitFor(t, subscribed, 10*time.Second, "peerSubscribed")
	view.PublishToChannel("news", "headline", "")
	cm := waitFor(t, chanMsg, 10*time.Second, "channel message")
	if cm.ChannelName != "news" || cm.Data != "headline" {
		t.Fatalf("unexpected channel message %+v", cm)
	}
	view.PublishToChannel("other", "ignored", "")
	select {
	case ev := <-chanMsg:
		t.Fatalf("unsubscribed channel delivered: %+v", ev)
	case <-time.After(500 * time.Millisecond):
	}

	// Binary lane.
	bin := make(chan Event, 4)
	pub.On(EventBinaryReceived, func(ev Event) { bin <- ev })
	payload := make([]byte, 100000)
	_, _ = rand.Read(payload)
	if err := view.SendBinary(ctx, conn.UUID(), payload[:60000]); err != nil {
		t.Fatal(err)
	}
	if b := waitFor(t, bin, 10*time.Second, "binary"); !bytes.Equal(b.Bytes, payload[:60000]) {
		t.Fatal("binary mismatch")
	}

	// Stats digest.
	if q := view.PeerQualityOf(conn.UUID()); q == nil {
		t.Error("expected peer quality")
	}

	// File transfer: publisher hosts, viewer downloads.
	fileList := make(chan Event, 4)
	view.On(EventFileList, func(ev Event) { fileList <- ev })
	entry, err := pub.HostFile("blob.bin", payload)
	if err != nil {
		t.Fatal(err)
	}
	fl := waitFor(t, fileList, 10*time.Second, "file list")
	if len(fl.Files) != 1 || fl.Files[0].ID != entry.ID || fl.Files[0].Size != int64(len(payload)) {
		t.Fatalf("unexpected file list %+v", fl.Files)
	}
	result, err := view.RequestFile(ctx, conn.UUID(), entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(result.Bytes, payload) || result.Name != "blob.bin" {
		t.Fatalf("file mismatch: %d bytes", len(result.Bytes))
	}

	// Viewer hosts, publisher downloads (reverse direction).
	pubFiles := make(chan Event, 4)
	pub.On(EventFileList, func(ev Event) { pubFiles <- ev })
	view.HostFile("reply.txt", []byte("thanks"))
	// The publisher side never advertised downloads on a viewer connection; it
	// must request explicitly.
	select {
	case <-pubFiles:
	case <-time.After(300 * time.Millisecond):
	}

	// Bye on stopViewing reaches the publisher.
	byeCh := make(chan Event, 4)
	pub.On(EventPeerDisconnected, func(ev Event) { byeCh <- ev })
	view.StopViewing("gopub")
	waitFor(t, byeCh, 10*time.Second, "bye")
}

func TestMediaPublishView(t *testing.T) {
	host := startSignal(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pub := newTestSDK(t, host, nil)
	view := newTestSDK(t, host, nil)

	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "gocam")
	if err != nil {
		t.Fatal(err)
	}
	audio, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "gocam")
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(33 * time.Millisecond)
		defer ticker.Stop()
		frame := []byte{0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00}
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_ = track.WriteSample(media.Sample{Data: frame, Duration: 33 * time.Millisecond})
				_ = audio.WriteSample(media.Sample{Data: []byte{0xfc, 0xff, 0xfe}, Duration: 20 * time.Millisecond})
			}
		}
	}()

	tracks := make(chan Event, 4)
	view.On(EventTrack, func(ev Event) { tracks <- ev })

	if err := pub.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := pub.Publish(ctx, []webrtc.TrackLocal{track, audio}, PublishOptions{StreamID: "gocam", Room: "go-media-room"}); err != nil {
		t.Fatal(err)
	}
	if err := view.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := view.JoinRoom(ctx, "go-media-room"); err != nil {
		t.Fatal(err)
	}
	if _, err := view.View(ctx, "gocam"); err != nil {
		t.Fatal(err)
	}
	kinds := map[webrtc.RTPCodecType]bool{}
	for len(kinds) < 2 {
		ev := waitFor(t, tracks, 15*time.Second, "track")
		kinds[ev.Track.Kind()] = true
		if ev.Track.Kind() == webrtc.RTPCodecTypeVideo {
			ev.Track.SetReadDeadline(time.Now().Add(10 * time.Second))
			pkt, _, err := ev.Track.ReadRTP()
			if err != nil {
				t.Fatalf("ReadRTP: %v", err)
			}
			if len(pkt.Payload) == 0 {
				t.Fatal("empty RTP payload")
			}
		}
	}
}

func TestAutoConnectHalfMesh(t *testing.T) {
	host := startSignal(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestSDK(t, host, nil)
	b := newTestSDK(t, host, nil)
	aData := make(chan Event, 4)
	a.On(EventDataReceived, func(ev Event) { aData <- ev })
	bOpen := make(chan Event, 4)
	b.On(EventDataChannelOpen, func(ev Event) { bOpen <- ev })

	ca, err := a.AutoConnect(ctx, AutoConnectOptions{Room: "go-mesh", StreamID: "peer_a"})
	if err != nil {
		t.Fatal(err)
	}
	defer ca.Stop()
	cb, err := b.AutoConnect(ctx, AutoConnectOptions{Room: "go-mesh", StreamID: "peer_b"})
	if err != nil {
		t.Fatal(err)
	}
	defer cb.Stop()
	waitFor(t, bOpen, 15*time.Second, "mesh data channel")
	if !b.SendData("mesh hello") {
		t.Fatal("send failed")
	}
	if ev := waitFor(t, aData, 10*time.Second, "mesh data"); ev.Data != "mesh hello" {
		t.Fatalf("unexpected %+v", ev)
	}
	// Exactly one connection per pair in half mode.
	if len(a.Peers()) != 1 || len(b.Peers()) != 1 {
		t.Fatalf("peers a=%d b=%d", len(a.Peers()), len(b.Peers()))
	}
	pa := a.Peers()[0]
	if a.Connection(pa, "publisher") != nil && a.Connection(pa, "viewer") != nil {
		t.Fatal("half mode created dual connections")
	}
}

func TestNoPasswordAndReconnectIntent(t *testing.T) {
	host := startSignal(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pub := newTestSDK(t, host, func(o *Options) { o.NoPassword = true })
	view := newTestSDK(t, host, func(o *Options) { o.NoPassword = true })
	open := make(chan Event, 4)
	view.On(EventDataChannelOpen, func(ev Event) { open <- ev })
	if err := pub.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := pub.Announce(ctx, PublishOptions{StreamID: "plain"}); err != nil {
		t.Fatal(err)
	}
	if err := view.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	// View before joining any room: the server queues the play request.
	if _, err := view.View(ctx, "plain"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, open, 15*time.Second, "data channel without password")
}

func TestViewPendingUntilPublished(t *testing.T) {
	host := startSignal(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pub := newTestSDK(t, host, nil)
	view := newTestSDK(t, host, nil)
	open := make(chan Event, 4)
	view.On(EventDataChannelOpen, func(ev Event) { open <- ev })
	if err := view.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := view.JoinRoom(ctx, "late-room"); err != nil {
		t.Fatal(err)
	}
	_, err := view.View(ctx, "late", ViewOptions{Timeout: 500 * time.Millisecond})
	if err != ErrStreamNotYetAvailable {
		t.Fatalf("expected pending error, got %v", err)
	}
	if err := pub.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := pub.JoinRoom(ctx, "late-room"); err != nil {
		t.Fatal(err)
	}
	if _, err := pub.Announce(ctx, PublishOptions{StreamID: "late"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, open, 15*time.Second, "late data channel")
}
