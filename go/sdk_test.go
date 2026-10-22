// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
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

func TestRoomPasswordOverrideAndReconnect(t *testing.T) {
	host := startSignal(t)
	for _, password := range []string{" \t ", "false", "0", "off", "café & literal%20"} {
		t.Run(password, func(t *testing.T) {
			s := newTestSDK(t, host, nil)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := s.Connect(ctx); err != nil {
				t.Fatal(err)
			}
			if err := s.JoinRoom(ctx, "password_room", JoinOptions{Password: password}); err != nil {
				t.Fatal(err)
			}
			expected := New(Options{Password: password, TURN: TURNDisabled})
			for i := 0; i < 2; i++ {
				pw, enabled := s.effectivePassword()
				want, _ := expected.effectivePassword()
				if !enabled || pw != want || s.hashedStreamID("camera") != expected.hashedStreamID("camera") {
					t.Fatal("password changed during join/reconnect")
				}
				s.LeaveRoom()
				if err := s.Connect(ctx); err != nil {
					t.Fatal(err)
				}
				if err := s.JoinRoom(ctx, "password_room"); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
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

func TestPublishingSurvivesSignalingReconnect(t *testing.T) {
	for _, mediaPublish := range []bool{false, true} {
		name := "announce"
		if mediaPublish {
			name = "publish"
		}
		t.Run(name, func(t *testing.T) {
			host := startSignal(t)
			pub := newTestSDK(t, host, func(o *Options) { o.ReconnectDelay = 50 * time.Millisecond })
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if err := pub.Connect(ctx); err != nil {
				t.Fatal(err)
			}
			opts := PublishOptions{StreamID: "reconnect-test"}
			if mediaPublish {
				track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "test")
				if err != nil {
					t.Fatal(err)
				}
				_, err = pub.Publish(ctx, []webrtc.TrackLocal{track}, opts)
				if err != nil {
					t.Fatal(err)
				}
			} else if _, err := pub.Announce(ctx, opts); err != nil {
				t.Fatal(err)
			}
			reconnected := make(chan Event, 1)
			pub.On(EventReconnected, func(ev Event) { reconnected <- ev })
			pub.mu.Lock()
			ws := pub.ws
			pub.mu.Unlock()
			_ = ws.Close()
			waitFor(t, reconnected, 5*time.Second, "signaling reconnect")
			pub.mu.Lock()
			publishing := pub.publishing
			pub.mu.Unlock()
			if !publishing {
				t.Fatal("publish intent was not restored")
			}
			view := newTestSDK(t, host, nil)
			opened := make(chan Event, 1)
			view.On(EventDataChannelOpen, func(ev Event) { opened <- ev })
			if err := view.Connect(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := view.View(ctx, opts.StreamID, ViewOptions{}); err != nil {
				t.Fatal(err)
			}
			waitFor(t, opened, 10*time.Second, "new viewer after reconnect")
		})
	}
}

func TestDisconnectCancelsReconnectBackoff(t *testing.T) {
	s := newTestSDK(t, startSignal(t), func(o *Options) { o.ReconnectDelay = 100 * time.Millisecond })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	attempt := make(chan Event, 1)
	s.On(EventReconnecting, func(ev Event) { attempt <- ev })
	s.mu.Lock()
	ws := s.ws
	s.mu.Unlock()
	_ = ws.Close()
	waitFor(t, attempt, time.Second, "reconnect backoff")
	s.Disconnect()
	time.Sleep(200 * time.Millisecond)
	if s.Connected() {
		t.Fatal("reconnect revived an explicitly disconnected SDK")
	}
	if err := s.Connect(ctx); err != nil {
		t.Fatalf("explicit connect after cancellation: %v", err)
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

func TestInitialOfferIsDataOnly(t *testing.T) {
	s := newTestSDK(t, "", nil)
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "camera")
	if err != nil {
		t.Fatal(err)
	}
	s.publishing = true
	s.localTracks = []webrtc.TrackLocal{track}
	c, err := s.createConnection("peer", "publisher")
	if err != nil {
		t.Fatal(err)
	}
	offer, err := s.createOffer(c, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(offer.SDP, "m=application ") || strings.Contains(offer.SDP, "m=video ") || strings.Contains(offer.SDP, "m=audio ") {
		t.Fatal("initial offer must contain only the data connection")
	}
	c.mu.Lock()
	c.allowVideo = true // Preferences alone are not enough; info must be sent.
	c.mu.Unlock()
	s.updateTracksForConnection(c)
	if err := s.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	if len(c.pc.GetSenders()) != 0 {
		t.Fatal("media attached before the control handshake")
	}
}

func TestDiscoveryRetriesCoalesceAndStop(t *testing.T) {
	s := newTestSDK(t, "", nil)
	s.connected = true
	s.pendingViews["late"] = ViewOptions{}
	msg := map[string]any{"streamID": s.hashedStreamID("late"), "UUID": "peer"}
	for i := 0; i < 20; i++ {
		s.handleVideoAddedToRoom(msg)
	}
	s.mu.Lock()
	n := len(s.viewRetryTimers)
	s.mu.Unlock()
	if n != 1 {
		t.Fatalf("wanted one cancellable retry, got %d", n)
	}
	s.StopViewing("late")
	time.Sleep(150 * time.Millisecond)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.queue) != 0 || len(s.viewRetryTimers) != 0 {
		t.Fatal("stopped discovery request was replayed")
	}
}

func TestMediaPublishView(t *testing.T) {
	for _, tc := range []struct {
		name         string
		audio, video bool
	}{
		{"both", true, true},
		{"data_then_both", false, false},
		{"audio_then_both", true, false},
		{"video_then_both", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) { testMediaPublishView(t, tc.audio, tc.video) })
	}
}

func testMediaPublishView(t *testing.T, initialAudio, initialVideo bool) {
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
	infoReceived := make(chan struct{}, 1)
	view.On(EventPeerInfo, func(ev Event) {
		select {
		case infoReceived <- struct{}{}:
		default:
		}
	})
	view.On(EventTrack, func(ev Event) {
		if len(infoReceived) == 0 {
			t.Error("media arrived before publisher info")
		}
		tracks <- ev
	})

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
	conn, err := view.View(ctx, "gocam", ViewOptions{Audio: &initialAudio, Video: &initialVideo})
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[webrtc.RTPCodecType]bool{}
	var received []*webrtc.TrackRemote
	expected := map[webrtc.RTPCodecType]bool{}
	if initialAudio {
		expected[webrtc.RTPCodecTypeAudio] = true
	}
	if initialVideo {
		expected[webrtc.RTPCodecTypeVideo] = true
	}
	for len(kinds) < len(expected) {
		ev := waitFor(t, tracks, 15*time.Second, "requested initial track")
		if !expected[ev.Track.Kind()] {
			t.Fatal("received unrequested media", ev.Track.Kind())
		}
		kinds[ev.Track.Kind()] = true
		received = append(received, ev.Track)
	}
	select {
	case ev := <-tracks:
		t.Fatal("unexpected additional initial track", ev.Track.Kind())
	case <-time.After(150 * time.Millisecond):
	}
	deadline := time.Now().Add(10 * time.Second)
	for !conn.controlOpen() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !conn.sendControl(map[string]any{"audio": true, "video": true}) {
		t.Fatal("failed to request both media kinds over the data channel")
	}
	for len(kinds) < 2 {
		ev := waitFor(t, tracks, 15*time.Second, "track")
		kinds[ev.Track.Kind()] = true
		received = append(received, ev.Track)
	}
	for _, track := range received {
		track.SetReadDeadline(time.Now().Add(10 * time.Second))
		pkt, _, err := track.ReadRTP()
		if err != nil {
			t.Fatalf("ReadRTP %s: %v", track.Kind(), err)
		}
		if len(pkt.Payload) == 0 {
			t.Fatal("empty RTP payload", track.Kind())
		}
	}
	if view.Connection(conn.UUID(), "viewer") != conn {
		t.Fatal("media preferences replaced the peer connection")
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

func TestReconnectRestoresPublish(t *testing.T) {
	host := startSignal(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pub := newTestSDK(t, host, func(o *Options) { o.ReconnectDelay = 100 * time.Millisecond })
	reconnected := make(chan Event, 1)
	pub.On(EventReconnected, func(ev Event) { reconnected <- ev })
	if err := pub.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := pub.Announce(ctx, PublishOptions{StreamID: "resume"}); err != nil {
		t.Fatal(err)
	}
	// Drop the signaling socket underneath the publisher, as a network failure would.
	pub.mu.Lock()
	ws := pub.ws
	pub.mu.Unlock()
	_ = ws.Close()
	waitFor(t, reconnected, 20*time.Second, "publisher reconnect")

	// The re-seeded stream must be viewable and the SDK must still count as publishing.
	view := newTestSDK(t, host, nil)
	open := make(chan Event, 4)
	view.On(EventDataChannelOpen, func(ev Event) { open <- ev })
	if err := view.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := view.View(ctx, "resume"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, open, 15*time.Second, "data channel after reconnect")
	if _, err := pub.Announce(ctx, PublishOptions{StreamID: "other"}); err != ErrAlreadyPublishing {
		t.Fatalf("expected ErrAlreadyPublishing after reconnect, got %v", err)
	}
}

func TestDisconnectClearsIntent(t *testing.T) {
	host := startSignal(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s := newTestSDK(t, host, func(o *Options) { o.ReconnectDelay = 100 * time.Millisecond })
	if err := s.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.JoinRoom(ctx, "old-room"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Announce(ctx, PublishOptions{StreamID: "stale"}); err != nil {
		t.Fatal(err)
	}
	s.Disconnect()
	// A fresh session with no room or stream, then an unexpected drop: the old
	// intent must not be replayed by the reconnect.
	if err := s.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	reconnected := make(chan Event, 1)
	s.On(EventReconnected, func(ev Event) { reconnected <- ev })
	s.mu.Lock()
	ws := s.ws
	s.mu.Unlock()
	_ = ws.Close()
	waitFor(t, reconnected, 10*time.Second, "reconnect after a fresh connect")
	s.mu.Lock()
	publishing, sid, joined := s.publishing, s.streamID, s.roomJoined
	s.mu.Unlock()
	if publishing || sid != "" || joined {
		t.Fatalf("stale intent replayed: publishing=%v streamID=%q roomJoined=%v", publishing, sid, joined)
	}
}

// Application sends must never use signaling, even with a known peer whose
// control channel has not opened yet.
func TestDataRequiresPeerChannel(t *testing.T) {
	s := New(Options{TURN: TURNDisabled, STUNServers: []string{}})
	s.connected = true
	s.connections["unopened-peer"] = &peerPair{}
	if s.SendDataTo("unopened-peer", "payload") || s.SendPing("unopened-peer") {
		t.Fatal("send succeeded without a data channel")
	}
	s.Subscribe("updates")
	s.Unsubscribe("updates")
	if len(s.queue) != 0 {
		t.Fatal("application data was queued on signaling")
	}
	events := make(chan Event, 1)
	s.On(EventDataReceived, func(ev Event) { events <- ev })
	s.handleSignalingMessage(map[string]any{"UUID": "unopened-peer", "__fallback": true, "pipe": "payload"})
	select {
	case <-events:
		t.Fatal("application data accepted from signaling")
	default:
	}
}

func TestLeaveRoomDisconnects(t *testing.T) {
	host := startSignal(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s := newTestSDK(t, host, nil)
	if err := s.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.JoinRoom(ctx, "old-room"); err != nil {
		t.Fatal(err)
	}
	s.LeaveRoom()
	if s.Connected() || s.Room() != "" {
		t.Fatal("leave did not disconnect")
	}
	if err := s.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.JoinRoom(ctx, "new-room"); err != nil {
		t.Fatal(err)
	}
	if s.Room() != "new_room" {
		t.Fatal("reconnected into the wrong room")
	}
}

func TestStreamNoticePreservesViewPreferences(t *testing.T) {
	s := New(Options{TURN: TURNDisabled, STUNServers: []string{}})
	s.pendingViews["late"] = ViewOptions{Audio: Bool(false), Video: Bool(false), Downloads: Bool(false)}
	s.handleVideoAddedToRoom(map[string]any{"streamID": "late" + s.passwordHash, "UUID": "publisher"})
	s.mu.Lock()
	opts, ok := s.pendingViews["late"]
	s.mu.Unlock()
	if !ok || opts.audio() || opts.video() || opts.downloads() {
		t.Fatal("offer arriving before retry lost the requested preferences")
	}
	s.Disconnect()
}

// AddTrack used to attach a sender directly, so it could duplicate a kind that
// the viewer-preference path was attaching at the same moment: two senders and
// two renegotiations for one track.
func TestAddTrackDoesNotDuplicateAnAttachedKind(t *testing.T) {
	host := startSignal(t)

	countAttached := func(c *Connection, kind webrtc.RTPCodecType) int {
		n := 0
		for _, sender := range c.pc.GetSenders() {
			if track := sender.Track(); track != nil && track.Kind() == kind {
				n++
			}
		}
		return n
	}

	fixture := 0
	establish := func(t *testing.T) (*SDK, *Connection) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		t.Cleanup(cancel)
		// Each attempt needs its own stream so the room never sees a duplicate.
		fixture++
		streamID := fmt.Sprintf("dupcam%d", fixture)
		room := fmt.Sprintf("go-dup-room%d", fixture)
		pub := newTestSDK(t, host, nil)
		view := newTestSDK(t, host, nil)
		audio, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "gocam")
		if err != nil {
			t.Fatal(err)
		}
		if err := pub.Connect(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := pub.Publish(ctx, []webrtc.TrackLocal{audio}, PublishOptions{StreamID: streamID, Room: room}); err != nil {
			t.Fatal(err)
		}
		if err := view.Connect(ctx); err != nil {
			t.Fatal(err)
		}
		if err := view.JoinRoom(ctx, room); err != nil {
			t.Fatal(err)
		}
		if _, err := view.View(ctx, streamID, ViewOptions{Audio: Bool(true), Video: Bool(false)}); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			var c *Connection
			pub.mu.Lock()
			for _, pair := range pub.connections {
				if pair.publisher != nil {
					c = pair.publisher
				}
			}
			pub.mu.Unlock()
			if c != nil {
				c.mu.Lock()
				ready := c.infoSent
				c.mu.Unlock()
				// Wait until the preference path has attached the audio the
				// viewer asked for; that is the state where a second attach of
				// an already-present kind used to slip through.
				if ready && c.controlOpen() && countAttached(c, webrtc.RTPCodecTypeAudio) == 1 {
					// The viewer wants video from here on.
					c.mu.Lock()
					c.allowVideo = true
					c.mu.Unlock()
					return pub, c
				}
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatal("publisher connection never completed the control handshake")
		return nil, nil
	}

	newVideo := func(t *testing.T, id string) webrtc.TrackLocal {
		track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, id, "gocam")
		if err != nil {
			t.Fatal(err)
		}
		return track
	}

	t.Run("after the preference path attached it", func(t *testing.T) {
		pub, c := establish(t)
		if err := pub.AddTrack(newVideo(t, "video")); err != nil {
			t.Fatal(err)
		}
		if got := countAttached(c, webrtc.RTPCodecTypeVideo); got != 1 {
			t.Fatalf("wanted one video sender after AddTrack, got %d", got)
		}
		if err := pub.AddTrack(newVideo(t, "video2")); err != nil {
			t.Fatal(err)
		}
		if got := countAttached(c, webrtc.RTPCodecTypeVideo); got != 1 {
			t.Fatalf("second video track added a duplicate sender: %d", got)
		}
	})

	t.Run("racing the preference path", func(t *testing.T) {
		for attempt := 0; attempt < 3; attempt++ {
			pub, c := establish(t)
			track := newVideo(t, "video")
			done := make(chan struct{}, 2)
			go func() { _ = pub.AddTrack(track); done <- struct{}{} }()
			go func() { pub.updateTracksForConnection(c); done <- struct{}{} }()
			<-done
			<-done
			if got := countAttached(c, webrtc.RTPCodecTypeVideo); got != 1 {
				t.Fatalf("attempt %d: wanted one video sender, got %d", attempt, got)
			}
		}
	})
}
