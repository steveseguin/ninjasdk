// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package vdoninja is the Go SDK for VDO.Ninja-compatible audio, video and data
// over WebRTC, using pion/webrtc as the engine and VDO.Ninja's hosted (or a
// self-hosted) signaling service for discovery.
//
// It speaks the same wire protocol as the JavaScript SDK and VDO.Ninja browser
// pages: hashed room and stream IDs, AES-CBC encrypted SDP/ICE, the
// "sendChannel" control data channel, publisher/viewer roles, ping/pong, pub/sub,
// request/response and VDO.Ninja's native file transfer.
//
// Hosted-service notice: use of signaling, TURN and other services operated by
// Steve Seguin is subject to the applicable Terms of Service and operational
// policies; this SDK is the supported way to use them. Only WebRTC handshake
// data may pass through the signaling server; application data belongs on
// peer-to-peer channels.
package vdoninja

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

// Version of the Go SDK.
const Version = "0.1.0"

// Errors returned by the SDK.
var (
	ErrNotConnected           = errors.New("vdoninja: not connected to signaling server")
	ErrAlreadyPublishing      = errors.New("vdoninja: already publishing on this connection; disconnect and reconnect to publish a different stream")
	ErrRoomRequired           = errors.New("vdoninja: room name is required")
	ErrRoomJoinTimeout        = errors.New("vdoninja: room join timeout")
	ErrStreamNotYetAvailable  = errors.New("vdoninja: stream not available yet; view request stays pending")
	ErrNotPublishing          = errors.New("vdoninja: not publishing")
	ErrNoDataChannel          = errors.New("vdoninja: no open data channel to peer")
	ErrPeerNotFound           = errors.New("vdoninja: peer not found")
	ErrRequestTimeout         = errors.New("vdoninja: request timeout")
	ErrCancelled              = errors.New("vdoninja: operation cancelled by disconnect")
	ErrEncryptionDisabled     = errors.New("vdoninja: password encryption disabled")
	ErrReservedChannelLabel   = errors.New("vdoninja: label uses the reserved x- prefix")
	ErrFileNotFound           = errors.New("vdoninja: file not found")
	ErrTransferCancelled      = errors.New("vdoninja: transfer cancelled")
	ErrTransferSizeMismatch   = errors.New("vdoninja: transfer size mismatch")
	ErrResourcesNotAdvertised = errors.New("vdoninja: peer did not advertise allowresources")
)

// StreamInfo tracks a stream seen in room listings or requested for viewing.
type StreamInfo struct {
	StreamID  string
	UUID      string
	State     string // "available", "pending", "connected", "disconnected", "failed"
	FirstSeen time.Time
	LastSeen  time.Time
}

type peerPair struct {
	publisher *Connection
	viewer    *Connection
}

type pendingCandidate struct {
	candidate webrtc.ICECandidateInit
	session   string
	ts        time.Time
}

type roomIntent struct {
	room     string
	password string
	claim    bool
}

// SDK is a VDO.Ninja peer. Create one with New, register handlers with On,
// then Connect, JoinRoom, Publish/Announce and View.
type SDK struct {
	opts Options
	bus  *eventBus
	api  *webrtc.API

	mu sync.Mutex

	ws          *websocket.Conn
	wsMu        sync.Mutex
	connected   bool
	intentional bool
	generation  int
	reconnects  int
	queue       [][]byte

	password     string // sanitized (URL-encoded) password, "" when disabled
	noPassword   bool
	salt         string
	passwordHash string

	room          string
	roomJoined    bool
	roomWaiters   []chan struct{}
	intentRoom    *roomIntent
	publishing    bool
	dataOnly      bool
	streamID      string
	localTracks   []webrtc.TrackLocal
	publisherInfo map[string]any

	connections     map[string]*peerPair
	pendingViews    map[string]ViewOptions
	viewIntent      map[string]ViewOptions
	stoppedViews    map[string]bool
	viewRetryTimers map[string]*time.Timer
	viewWaiters     map[string][]chan *Connection
	streams         map[string]*StreamInfo
	pendingICE      map[string][]pendingCandidate

	subscriptions   map[string]bool
	peerSubs        map[string]map[string]bool
	pendingRequests map[string]*pendingRequest
	requestHandlers map[string]RequestHandler

	hostedFiles map[string]*hostedFile
	inbound     map[string]*inboundTransfer

	turnMu      sync.Mutex
	turnList    []webrtc.ICEServer
	turnFetched time.Time
}

// New creates an SDK instance. The returned SDK is not connected yet.
func New(opts Options) *SDK {
	o := opts.withDefaults()
	s := &SDK{
		opts:            o,
		bus:             newEventBus(),
		api:             o.API,
		salt:            o.Salt,
		connections:     map[string]*peerPair{},
		pendingViews:    map[string]ViewOptions{},
		viewIntent:      map[string]ViewOptions{},
		stoppedViews:    map[string]bool{},
		viewRetryTimers: map[string]*time.Timer{},
		viewWaiters:     map[string][]chan *Connection{},
		streams:         map[string]*StreamInfo{},
		pendingICE:      map[string][]pendingCandidate{},
		subscriptions:   map[string]bool{},
		peerSubs:        map[string]map[string]bool{},
		pendingRequests: map[string]*pendingRequest{},
		requestHandlers: map[string]RequestHandler{},
		hostedFiles:     map[string]*hostedFile{},
		inbound:         map[string]*inboundTransfer{},
		publisherInfo:   map[string]any{},
	}
	if s.api == nil {
		s.api = webrtc.NewAPI()
	}
	s.room = SanitizeRoom(o.Room)
	if o.NoPassword {
		s.noPassword = true
	} else if o.Password == "" {
		s.password = SanitizePassword(DefaultPassword)
	} else {
		s.password = SanitizePassword(o.Password)
	}
	s.refreshPasswordHash()
	s.setPublisherInfo(o.Label, o.Meta, o.Order, o.Info)
	return s
}

func (s *SDK) logf(format string, args ...any) {
	if s.opts.Debug {
		s.opts.Logger.Printf("[vdoninja] "+format, args...)
	}
}

// refreshPasswordHash must be called with s.mu held or before the SDK is shared.
func (s *SDK) refreshPasswordHash() {
	if s.noPassword {
		s.passwordHash = ""
		return
	}
	s.passwordHash = StreamHashSuffix(s.password, s.salt)
}

// effectivePassword returns the sanitized password or "" and false when encryption is disabled.
func (s *SDK) effectivePassword() (string, bool) {
	if s.noPassword {
		return "", false
	}
	if s.password == "" {
		return SanitizePassword(DefaultPassword), true
	}
	return s.password, true
}

func (s *SDK) encryptionPhrase() (string, bool) {
	p, ok := s.effectivePassword()
	if !ok {
		return "", false
	}
	return p + s.salt, true
}

func (s *SDK) encrypt(v any) (string, string, error) {
	phrase, ok := s.encryptionPhrase()
	if !ok {
		return "", "", ErrEncryptionDisabled
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "", "", err
	}
	return EncryptMessage(string(b), phrase)
}

func (s *SDK) decryptInto(ciphertext, iv string, out any) error {
	phrase, ok := s.encryptionPhrase()
	if !ok {
		return ErrEncryptionDisabled
	}
	plain, err := DecryptMessage(ciphertext, iv, phrase)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(plain), out)
}

func (s *SDK) hashedStreamID(streamID string) string {
	if s.noPassword {
		return streamID
	}
	return streamID + s.passwordHash
}

func (s *SDK) stripHash(streamID string) string {
	if s.noPassword || s.passwordHash == "" || len(streamID) <= len(s.passwordHash) {
		return streamID
	}
	if streamID[len(streamID)-len(s.passwordHash):] == s.passwordHash {
		return streamID[:len(streamID)-len(s.passwordHash)]
	}
	return streamID
}

func (s *SDK) setPublisherInfo(label string, meta any, order string, info map[string]any) {
	if label != "" {
		s.publisherInfo["label"] = SanitizeLabel(label)
	}
	if meta != nil {
		if m := sanitizeMeta(meta, 0); m != nil && m != "" {
			s.publisherInfo["meta"] = m
		}
	}
	if order != "" {
		s.publisherInfo["order"] = SanitizeLabel(order)
	}
	for k, v := range info {
		switch k {
		case "broadcast", "allowdrawing", "iframe", "widget", "allowmidi", "allowresources":
			if b, ok := v.(bool); ok {
				s.publisherInfo[k] = b
			}
		case "allowchunked":
			switch v.(type) {
			case bool, int, float64:
				s.publisherInfo[k] = v
			}
		case "label":
			if str, ok := v.(string); ok {
				s.publisherInfo["label"] = SanitizeLabel(str)
			}
		case "meta":
			if m := sanitizeMeta(v, 0); m != nil && m != "" {
				s.publisherInfo["meta"] = m
			}
		case "order":
			if str, ok := v.(string); ok {
				s.publisherInfo["order"] = SanitizeLabel(str)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Signaling connection
// ---------------------------------------------------------------------------

// Connect opens the signaling WebSocket. It returns once the socket is open.
func (s *SDK) Connect(ctx context.Context) error {
	s.mu.Lock()
	if s.connected {
		s.mu.Unlock()
		return nil
	}
	s.intentional = false
	host := s.opts.Host
	gen := s.generation
	s.mu.Unlock()

	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	header := http.Header{}
	conn, _, err := dialer.DialContext(ctx, host, header)
	if err != nil {
		return fmt.Errorf("vdoninja: signaling dial: %w", err)
	}

	s.mu.Lock()
	if gen != s.generation || s.intentional {
		s.mu.Unlock()
		_ = conn.Close()
		return ErrCancelled
	}
	s.ws = conn
	s.connected = true
	if !s.isReconnecting() {
		s.reconnects = 0
	}
	queued := s.queue
	s.queue = nil
	s.mu.Unlock()

	for _, b := range queued {
		s.writeWS(b)
	}
	s.logf("WebSocket connected to %s", host)
	s.emit(Event{Type: EventConnected})
	go s.readLoop(conn, gen)
	return nil
}

func (s *SDK) isReconnecting() bool { return s.reconnects > 0 }

func (s *SDK) readLoop(conn *websocket.Conn, gen int) {
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil || msg == nil {
			s.logf("Unparseable signaling message: %v", err)
			continue
		}
		s.logf("<- WS %s", truncate(string(data), 300))
		s.handleSignalingMessage(msg)
	}

	s.mu.Lock()
	if s.ws != conn || gen != s.generation {
		s.mu.Unlock()
		return
	}
	s.ws = nil
	s.connected = false
	s.roomJoined = false
	s.publishing = false
	intentional := s.intentional
	willReconnect := !intentional && s.reconnects < s.opts.MaxReconnectAttempts
	s.mu.Unlock()

	if !intentional {
		s.emit(Event{Type: EventDisconnected, Intentional: false, Reason: "socket-closed", WillReconnect: willReconnect})
		if willReconnect {
			go s.reconnect(gen)
		}
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func (s *SDK) reconnect(gen int) {
	for {
		s.mu.Lock()
		if s.intentional || gen != s.generation || s.connected {
			s.mu.Unlock()
			return
		}
		if s.reconnects >= s.opts.MaxReconnectAttempts {
			s.mu.Unlock()
			s.emit(Event{Type: EventReconnectFailed, Message: "max reconnect attempts reached"})
			return
		}
		s.reconnects++
		attempt := s.reconnects
		s.mu.Unlock()

		delay := s.opts.ReconnectDelay * time.Duration(1<<uint(attempt-1))
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
		s.emit(Event{Type: EventReconnecting, Message: fmt.Sprintf("attempt %d", attempt)})
		time.Sleep(delay)

		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		err := s.Connect(ctx)
		cancel()
		if err != nil {
			s.logf("Reconnect attempt %d failed: %v", attempt, err)
			continue
		}
		s.restoreIntent()
		s.mu.Lock()
		s.reconnects = 0
		s.mu.Unlock()
		s.emit(Event{Type: EventReconnected})
		return
	}
}

// restoreIntent replays room, publish/announce and view operations after a reconnect.
func (s *SDK) restoreIntent() {
	s.mu.Lock()
	room := s.intentRoom
	// readLoop clears publishing when the socket drops; the retained stream ID
	// is the publish intent (StopPublishing clears it), as _connectionIntent is
	// in the JavaScript SDK.
	wasPublishing := s.streamID != ""
	streamID := s.streamID
	views := make(map[string]ViewOptions, len(s.viewIntent))
	for k, v := range s.viewIntent {
		if !s.stoppedViews[k] {
			views[k] = v
		}
	}
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if room != nil {
		if err := s.JoinRoom(ctx, room.room, JoinOptions{Claim: room.claim, keepPassword: true}); err != nil {
			s.logf("restore room failed: %v", err)
		}
	}
	if wasPublishing {
		// Re-seed directly rather than through Announce/Publish, which refuse a
		// second publish per connection; publishing goes back on so offerSDP
		// requests from new viewers are served.
		s.mu.Lock()
		hashed := s.hashedStreamID(streamID)
		s.publishing = true
		s.mu.Unlock()
		s.sendWS(map[string]any{"request": "seed", "streamID": hashed})
	}
	for sid, opts := range views {
		go func(sid string, opts ViewOptions) {
			_, _ = s.View(context.Background(), sid, opts)
		}(sid, opts)
	}
}

// Disconnect sends bye to peers, closes every peer connection and the
// signaling socket, and emits a single disconnected event.
func (s *SDK) Disconnect() {
	s.mu.Lock()
	s.intentional = true
	s.generation++
	ws := s.ws
	s.ws = nil
	s.connected = false
	s.roomJoined = false
	s.publishing = false
	s.queue = nil
	for _, t := range s.viewRetryTimers {
		t.Stop()
	}
	s.viewRetryTimers = map[string]*time.Timer{}
	conns := s.connections
	s.connections = map[string]*peerPair{}
	s.pendingViews = map[string]ViewOptions{}
	s.pendingICE = map[string][]pendingCandidate{}
	pending := s.pendingRequests
	s.pendingRequests = map[string]*pendingRequest{}
	waiters := s.roomWaiters
	s.roomWaiters = nil
	s.mu.Unlock()

	for _, w := range waiters {
		close(w)
	}
	for _, p := range pending {
		p.fail(ErrCancelled)
	}
	for _, pair := range conns {
		for _, c := range []*Connection{pair.publisher, pair.viewer} {
			if c == nil {
				continue
			}
			c.sendControl(map[string]any{"bye": true})
			c.close()
		}
	}
	// Give bye messages a moment to flush before tearing down transports.
	time.Sleep(50 * time.Millisecond)
	if ws != nil {
		_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
		_ = ws.Close()
	}
	s.emit(Event{Type: EventDisconnected, Intentional: true, Reason: "local-disconnect"})
}

// Connected reports whether the signaling socket is open.
func (s *SDK) Connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connected
}

// writeWS writes raw bytes to the socket, queuing when not connected.
func (s *SDK) writeWS(b []byte) bool {
	s.mu.Lock()
	ws := s.ws
	intentional := s.intentional
	if ws == nil {
		if intentional {
			s.mu.Unlock()
			return false
		}
		s.queue = append(s.queue, b)
		if len(s.queue) > signalingQueueSize {
			s.queue = s.queue[len(s.queue)-signalingQueueSize:]
		}
		s.mu.Unlock()
		return true
	}
	s.mu.Unlock()
	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	if err := ws.WriteMessage(websocket.TextMessage, b); err != nil {
		s.logf("WebSocket write failed: %v", err)
		return false
	}
	return true
}

// sendWS marshals and sends a signaling message, adding ClientID as "from" when configured.
func (s *SDK) sendWS(msg map[string]any) bool {
	if s.opts.ClientID != "" {
		msg["from"] = s.opts.ClientID
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return false
	}
	s.logf("-> WS %s", truncate(string(b), 300))
	return s.writeWS(b)
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

// JoinOptions configures JoinRoom.
type JoinOptions struct {
	// Password overrides the instance password for hashing (original text).
	Password string
	// Claim attempts to become the room director.
	Claim bool

	keepPassword bool
}

// JoinRoom joins a room (hashed with the password and salt) and waits for the
// server's listing. Only one room can be joined per signaling connection.
func (s *SDK) JoinRoom(ctx context.Context, room string, opts ...JoinOptions) error {
	var o JoinOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	s.mu.Lock()
	if !s.connected {
		s.mu.Unlock()
		return ErrNotConnected
	}
	if s.roomJoined {
		s.mu.Unlock()
		s.logf("Already joined a room on this connection")
		return nil
	}
	gen := s.generation
	room = SanitizeRoom(room)
	if room == "" {
		room = s.room
	}
	if room == "" {
		s.mu.Unlock()
		return ErrRoomRequired
	}
	if o.Password != "" && !o.keepPassword {
		s.password = SanitizePassword(o.Password)
		s.noPassword = false
		s.refreshPasswordHash()
	}
	s.intentRoom = &roomIntent{room: room, password: s.password, claim: o.Claim}
	hashedRoom := room
	if p, ok := s.effectivePassword(); ok {
		hashedRoom = HashRoom(room, p, s.salt)
	}
	wait := make(chan struct{})
	s.roomWaiters = append(s.roomWaiters, wait)
	s.mu.Unlock()

	msg := map[string]any{"request": "joinroom", "roomid": hashedRoom}
	if o.Claim {
		msg["claim"] = true
	}
	s.logf("Joining room %q as %q", room, hashedRoom)
	s.sendWS(msg)

	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case <-wait:
	case <-timer.C:
		s.removeRoomWaiter(wait)
		return ErrRoomJoinTimeout
	case <-ctx.Done():
		s.removeRoomWaiter(wait)
		return ctx.Err()
	}
	s.mu.Lock()
	if gen != s.generation || s.intentional {
		s.mu.Unlock()
		return ErrCancelled
	}
	s.room = room
	s.roomJoined = true
	s.mu.Unlock()
	s.emit(Event{Type: EventRoomJoined, Data: room})
	return nil
}

func (s *SDK) removeRoomWaiter(w chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.roomWaiters {
		if x == w {
			s.roomWaiters = append(s.roomWaiters[:i], s.roomWaiters[i+1:]...)
			return
		}
	}
}

// LeaveRoom sends the leave message (as the JavaScript SDK does) and forgets
// the room locally.
func (s *SDK) LeaveRoom() {
	s.mu.Lock()
	room := s.room
	s.room = ""
	s.roomJoined = false
	s.intentRoom = nil
	s.mu.Unlock()
	if room == "" {
		return
	}
	s.sendWS(map[string]any{"leave": true})
	s.emit(Event{Type: EventRoomLeft, Data: room})
}

// Room returns the joined room name, if any.
func (s *SDK) Room() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.roomJoined {
		return s.room
	}
	return ""
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

// Announce registers a data-only stream so peers can connect to it.
func (s *SDK) Announce(ctx context.Context, opts PublishOptions) (string, error) {
	return s.seed(ctx, nil, true, opts)
}

// Publish registers a media stream. tracks are pion local tracks (for example
// TrackLocalStaticSample or TrackLocalStaticRTP); each viewer connection gets
// its own RTP senders bound to them.
func (s *SDK) Publish(ctx context.Context, tracks []webrtc.TrackLocal, opts PublishOptions) (string, error) {
	return s.seed(ctx, tracks, false, opts)
}

func (s *SDK) seed(ctx context.Context, tracks []webrtc.TrackLocal, dataOnly bool, opts PublishOptions) (string, error) {
	s.mu.Lock()
	if !s.connected {
		s.mu.Unlock()
		return "", ErrNotConnected
	}
	if s.publishing {
		// One publish per signaling connection, like the JavaScript SDK: the
		// server rejects a changed stream ID on a live socket.
		s.mu.Unlock()
		return "", ErrAlreadyPublishing
	}
	gen := s.generation
	s.setPublisherInfo(opts.Label, opts.Meta, opts.Order, opts.Info)
	streamID := SanitizeStreamID(opts.StreamID)
	if opts.StreamID == "" && s.streamID != "" {
		streamID = s.streamID
	}
	roomJoined := s.roomJoined
	s.mu.Unlock()

	if !roomJoined && opts.Room != "" {
		if err := s.JoinRoom(ctx, opts.Room, JoinOptions{Password: opts.Password}); err != nil {
			return "", err
		}
	}

	s.mu.Lock()
	if gen != s.generation || s.intentional {
		s.mu.Unlock()
		return "", ErrCancelled
	}
	hashed := s.hashedStreamID(streamID)
	s.streamID = streamID
	s.publishing = true
	s.dataOnly = dataOnly
	if !dataOnly {
		s.localTracks = tracks
	}
	now := time.Now()
	s.streams[streamID] = &StreamInfo{StreamID: streamID, State: "connected", FirstSeen: now, LastSeen: now}
	s.mu.Unlock()

	s.logf("Seeding streamID %q as %q (dataOnly=%v)", streamID, hashed, dataOnly)
	s.sendWS(map[string]any{"request": "seed", "streamID": hashed})
	s.emit(Event{Type: EventPublishing, StreamID: streamID, Data: map[string]any{"hashedStreamID": hashed, "dataOnly": dataOnly}})
	return streamID, nil
}

// StopPublishing closes publisher connections and stops offering the stream.
func (s *SDK) StopPublishing() {
	s.mu.Lock()
	if !s.publishing && s.streamID == "" {
		s.mu.Unlock()
		return
	}
	streamID := s.streamID
	s.publishing = false
	s.streamID = ""
	s.localTracks = nil
	var closing []*Connection
	for uuid, pair := range s.connections {
		if pair.publisher != nil {
			closing = append(closing, pair.publisher)
			pair.publisher = nil
		}
		if pair.publisher == nil && pair.viewer == nil {
			delete(s.connections, uuid)
		}
	}
	s.mu.Unlock()
	for _, c := range closing {
		c.sendControl(map[string]any{"bye": true})
		c.close()
	}
	s.emit(Event{Type: EventPublishingStop, StreamID: streamID})
}

// StreamID returns the stream ID this peer publishes/announces, if any.
func (s *SDK) StreamID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streamID
}

// AddTrack adds a track to an active media publish and renegotiates every
// publisher connection.
func (s *SDK) AddTrack(track webrtc.TrackLocal) error {
	s.mu.Lock()
	if !s.publishing || s.dataOnly {
		s.mu.Unlock()
		return ErrNotPublishing
	}
	s.localTracks = append(s.localTracks, track)
	var conns []*Connection
	for _, pair := range s.connections {
		if pair.publisher != nil {
			conns = append(conns, pair.publisher)
		}
	}
	s.mu.Unlock()
	for _, c := range conns {
		if (track.Kind() == webrtc.RTPCodecTypeAudio && !c.allowAudio) || (track.Kind() == webrtc.RTPCodecTypeVideo && !c.allowVideo) {
			continue
		}
		sender, err := c.pc.AddTrack(track)
		if err != nil {
			s.logf("AddTrack to %s failed: %v", c.uuid, err)
			continue
		}
		c.mu.Lock()
		c.senders = append(c.senders, sender)
		c.senderKinds[sender] = track.Kind()
		c.mu.Unlock()
		go s.drainRTCP(sender)
		if err := s.renegotiate(c, false); err != nil {
			s.logf("renegotiate %s failed: %v", c.uuid, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Viewing
// ---------------------------------------------------------------------------

// View requests a stream. It returns the viewer connection once the
// publisher's offer has been answered, or ErrStreamNotYetAvailable after the
// timeout while keeping the request pending (the stream connects automatically
// when it appears in the room).
func (s *SDK) View(ctx context.Context, streamID string, opts ...ViewOptions) (*Connection, error) {
	var o ViewOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	if o.Timeout <= 0 {
		o.Timeout = 15 * time.Second
	}
	o.Label = SanitizeLabel(o.Label)
	streamID = SanitizeStreamID(streamID)

	s.mu.Lock()
	if !s.connected {
		s.mu.Unlock()
		return nil, ErrNotConnected
	}
	gen := s.generation
	hashed := s.hashedStreamID(streamID)
	now := time.Now()
	info := s.streams[streamID]
	if info == nil {
		info = &StreamInfo{StreamID: streamID, FirstSeen: now}
		s.streams[streamID] = info
	}
	info.LastSeen = now
	info.State = "pending"
	s.viewIntent[streamID] = o
	delete(s.stoppedViews, streamID)
	s.pendingViews[streamID] = o
	if t := s.viewRetryTimers[streamID]; t != nil {
		t.Stop()
		delete(s.viewRetryTimers, streamID)
	}
	// Already connected? Return it.
	for _, pair := range s.connections {
		if pair.viewer != nil && pair.viewer.streamID == streamID {
			c := pair.viewer
			s.mu.Unlock()
			return c, nil
		}
	}
	wait := make(chan *Connection, 1)
	s.viewWaiters[streamID] = append(s.viewWaiters[streamID], wait)
	s.mu.Unlock()

	s.logf("Requesting stream %q as %q", streamID, hashed)
	s.sendWS(map[string]any{"request": "play", "streamID": hashed})

	timer := time.NewTimer(o.Timeout)
	defer timer.Stop()
	select {
	case c := <-wait:
		if c == nil {
			return nil, ErrCancelled
		}
		return c, nil
	case <-timer.C:
		s.removeViewWaiter(streamID, wait)
		s.mu.Lock()
		if gen != s.generation || s.intentional {
			s.mu.Unlock()
			return nil, ErrCancelled
		}
		s.mu.Unlock()
		s.scheduleViewRetry(streamID, o, s.opts.ViewRetryInterval)
		return nil, ErrStreamNotYetAvailable
	case <-ctx.Done():
		s.removeViewWaiter(streamID, wait)
		return nil, ctx.Err()
	}
}

func (s *SDK) removeViewWaiter(streamID string, w chan *Connection) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.viewWaiters[streamID]
	for i, x := range list {
		if x == w {
			s.viewWaiters[streamID] = append(list[:i], list[i+1:]...)
			return
		}
	}
}

func (s *SDK) scheduleViewRetry(streamID string, o ViewOptions, delay time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.intentional || s.stoppedViews[streamID] {
		return
	}
	if t := s.viewRetryTimers[streamID]; t != nil {
		t.Stop()
	}
	gen := s.generation
	s.viewRetryTimers[streamID] = time.AfterFunc(delay, func() {
		s.mu.Lock()
		delete(s.viewRetryTimers, streamID)
		stop := gen != s.generation || s.intentional || s.stoppedViews[streamID] || !s.connected
		s.mu.Unlock()
		if stop {
			return
		}
		s.logf("Retrying view for %q", streamID)
		_, _ = s.View(context.Background(), streamID, o)
	})
}

// StopViewing sends bye to the publisher and closes the viewer connection.
func (s *SDK) StopViewing(streamID string) {
	streamID = SanitizeStreamID(streamID)
	s.mu.Lock()
	delete(s.viewIntent, streamID)
	s.stoppedViews[streamID] = true
	if t := s.viewRetryTimers[streamID]; t != nil {
		t.Stop()
		delete(s.viewRetryTimers, streamID)
	}
	delete(s.pendingViews, streamID)
	var closing []*Connection
	for uuid, pair := range s.connections {
		if pair.viewer != nil && pair.viewer.streamID == streamID {
			closing = append(closing, pair.viewer)
			pair.viewer = nil
			if pair.publisher == nil {
				delete(s.connections, uuid)
			}
		}
	}
	if info := s.streams[streamID]; info != nil {
		info.State = "available"
	}
	s.mu.Unlock()
	for _, c := range closing {
		c.sendControl(map[string]any{"bye": true})
		c.close()
	}
	s.emit(Event{Type: EventViewingStopped, StreamID: streamID})
}

// Streams returns the streams seen so far (room listings, announcements and
// view requests), most recently seen first.
func (s *SDK) Streams() []StreamInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]StreamInfo, 0, len(s.streams))
	for _, v := range s.streams {
		out = append(out, *v)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].LastSeen.After(out[j-1].LastSeen); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Peers returns the UUIDs of every peer with at least one connection.
func (s *SDK) Peers() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.connections))
	for uuid := range s.connections {
		out = append(out, uuid)
	}
	return out
}

// Connection returns the connection of the given type ("publisher" or
// "viewer") to a peer, or nil.
func (s *SDK) Connection(uuid, typ string) *Connection {
	s.mu.Lock()
	defer s.mu.Unlock()
	pair := s.connections[uuid]
	if pair == nil {
		return nil
	}
	if typ == "publisher" {
		return pair.publisher
	}
	return pair.viewer
}

// ---------------------------------------------------------------------------
// Signaling message handling
// ---------------------------------------------------------------------------

func getString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func (s *SDK) handleSignalingMessage(msg map[string]any) {
	switch {
	case msg["description"] != nil:
		s.handleSDP(msg, nil)
	case msg["candidate"] != nil:
		s.handleRemoteCandidates(msg, nil, true)
	case msg["candidates"] != nil:
		s.handleRemoteCandidates(msg, nil, false)
	case msg["iceRestartRequest"] != nil && getString(msg, "UUID") != "":
		if c := s.Connection(getString(msg, "UUID"), "publisher"); c != nil {
			s.restartICE(c, "remote_request")
		}
	case msg["request"] != nil:
		switch getString(msg, "request") {
		case "joinroom":
			s.handlePeerJoinRoom(msg)
		case "play":
			s.handlePlayRequest(msg)
		case "listing":
			s.handleListing(msg, EventListing)
		case "videoaddedtoroom":
			s.handleVideoAddedToRoom(msg)
		case "someonejoined":
			s.handleSomeoneJoined(msg)
		case "error":
			s.emit(Event{Type: EventError, Message: getString(msg, "message"), Raw: msg})
		case "alert":
			s.handleAlert(msg)
		case "transferred":
			s.emit(Event{Type: EventTransferred, Raw: msg})
			s.handleListing(msg, EventListing)
		case "offerSDP":
			s.handleOfferRequest(getString(msg, "UUID"), "")
		}
	case msg["rejected"] != nil:
		s.emit(Event{Type: EventAlert, Message: "connection rejected", Raw: msg})
	case msg["approved"] != nil:
		s.emit(Event{Type: EventAlert, Message: "connection approved", Raw: msg})
	case msg["bye"] != nil:
		s.handleBye(getString(msg, "UUID"), EventBye, msg)
	case msg["hangup"] != nil:
		s.handleBye(getString(msg, "UUID"), EventHangup, msg)
	case msg["pipe"] != nil && msg["__fallback"] != nil:
		s.handleFallbackData(msg)
	}
}

func (s *SDK) handleAlert(msg map[string]any) {
	text := getString(msg, "message")
	if contains(text, "Stream ID is already in use") {
		s.mu.Lock()
		s.publishing = false
		s.streamID = ""
		s.mu.Unlock()
	}
	s.emit(Event{Type: EventAlert, Message: text, Raw: msg})
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func (s *SDK) handleListing(msg map[string]any, typ EventType) {
	s.mu.Lock()
	waiters := s.roomWaiters
	s.roomWaiters = nil
	now := time.Now()
	var entries []ListingEntry
	if list, ok := msg["list"].([]any); ok {
		for _, item := range list {
			var e ListingEntry
			switch v := item.(type) {
			case string:
				e.StreamID = s.stripHash(v)
			case map[string]any:
				e.StreamID = s.stripHash(getString(v, "streamID"))
				e.UUID = getString(v, "UUID")
				if e.UUID == "" {
					e.UUID = getString(v, "uuid")
				}
				e.Label = getString(v, "label")
				e.Director, _ = v["director"].(bool)
			}
			if e.StreamID != "" {
				info := s.streams[e.StreamID]
				if info == nil {
					info = &StreamInfo{StreamID: e.StreamID, FirstSeen: now}
					s.streams[e.StreamID] = info
				}
				info.LastSeen = now
				if e.UUID != "" {
					info.UUID = e.UUID
				}
				if info.State == "" || info.State == "disconnected" {
					info.State = "available"
				}
			}
			entries = append(entries, e)
		}
	} else if sid := getString(msg, "streamID"); sid != "" {
		entries = append(entries, ListingEntry{StreamID: s.stripHash(sid), UUID: getString(msg, "UUID")})
	}
	s.mu.Unlock()
	for _, w := range waiters {
		close(w)
	}
	s.emit(Event{Type: typ, List: entries, Raw: msg})
}

func (s *SDK) handleVideoAddedToRoom(msg map[string]any) {
	s.mu.Lock()
	clean := s.stripHash(getString(msg, "streamID"))
	uuid := getString(msg, "UUID")
	now := time.Now()
	if clean != "" {
		info := s.streams[clean]
		if info == nil {
			info = &StreamInfo{StreamID: clean, FirstSeen: now, State: "available"}
			s.streams[clean] = info
		}
		info.LastSeen = now
		if uuid != "" {
			info.UUID = uuid
		}
	}
	opts, pending := s.pendingViews[clean]
	if pending {
		delete(s.pendingViews, clean)
	}
	s.mu.Unlock()
	if pending {
		s.logf("Re-requesting pending stream that just became available: %s", clean)
		go func() {
			time.Sleep(100 * time.Millisecond)
			_, _ = s.View(context.Background(), clean, opts)
		}()
	}
	s.emit(Event{Type: EventVideoAddedToRoom, StreamID: clean, UUID: uuid, Raw: msg})
}

func (s *SDK) handleSomeoneJoined(msg map[string]any) {
	s.mu.Lock()
	clean := s.stripHash(getString(msg, "streamID"))
	s.mu.Unlock()
	uuid := getString(msg, "UUID")
	if clean != "" {
		s.emit(Event{Type: EventVideoAddedToRoom, StreamID: clean, UUID: uuid, Raw: msg})
	}
	s.emit(Event{Type: EventSomeoneJoined, StreamID: clean, UUID: uuid, Raw: msg})
}

// handlePeerJoinRoom handles a joinroom notice relayed by a fan-out server: a
// publisher offers to the newcomer.
func (s *SDK) handlePeerJoinRoom(msg map[string]any) {
	uuid := getString(msg, "UUID")
	if uuid == "" {
		return
	}
	s.mu.Lock()
	publishing := s.publishing
	s.mu.Unlock()
	if !publishing {
		return
	}
	session := getString(msg, "session")
	if session == "" {
		session = uuid
	}
	s.handleOfferRequest(uuid, session)
}

func (s *SDK) handlePlayRequest(msg map[string]any) {
	s.mu.Lock()
	requested := s.stripHash(getString(msg, "streamID"))
	ok := s.publishing && s.streamID == requested
	s.mu.Unlock()
	if !ok {
		s.logf("Ignoring play request for %q (not publishing it)", requested)
		return
	}
	s.handleOfferRequest(getString(msg, "UUID"), "")
}

// handleOfferRequest creates a publisher connection to uuid and sends an offer.
func (s *SDK) handleOfferRequest(uuid, session string) {
	if uuid == "" {
		return
	}
	s.mu.Lock()
	if !s.publishing {
		s.mu.Unlock()
		return
	}
	streamID := s.streamID
	s.mu.Unlock()
	if session == "" {
		session = generateSession()
	}
	c, err := s.createConnection(uuid, "publisher")
	if err != nil {
		s.emit(Event{Type: EventError, Err: err, UUID: uuid})
		return
	}
	c.streamID = streamID
	c.session = session
	offer, err := s.createOffer(c, false)
	if err != nil {
		s.logf("createOffer for %s failed: %v", uuid, err)
		s.emit(Event{Type: EventError, Err: err, UUID: uuid})
		return
	}
	s.sendDescription(c, offer, true)
}

func (s *SDK) handleBye(uuid string, typ EventType, msg map[string]any) {
	if uuid == "" {
		return
	}
	s.mu.Lock()
	delete(s.pendingICE, "local:"+uuid)
	delete(s.pendingICE, "remote:"+uuid)
	pair := s.connections[uuid]
	delete(s.connections, uuid)
	var retryStream string
	var retryOpts ViewOptions
	if pair != nil && pair.viewer != nil && pair.viewer.streamID != "" && !s.intentional && !s.stoppedViews[pair.viewer.streamID] {
		retryStream = pair.viewer.streamID
		retryOpts = pair.viewer.viewOptions
		if info := s.streams[retryStream]; info != nil {
			info.State = "disconnected"
		}
	}
	s.mu.Unlock()
	if pair != nil {
		for _, c := range []*Connection{pair.publisher, pair.viewer} {
			if c != nil {
				c.close()
			}
		}
	}
	if retryStream != "" {
		s.logf("Viewer connection for %s ended with %s; retrying in 2s", retryStream, typ)
		s.scheduleViewRetry(retryStream, retryOpts, 2*time.Second)
	}
	s.emit(Event{Type: typ, UUID: uuid, Raw: msg})
	s.emit(Event{Type: EventPeerDisconnected, UUID: uuid})
}

func (s *SDK) handleFallbackData(msg map[string]any) {
	uuid := getString(msg, "UUID")
	pipe := msg["pipe"]
	if m, ok := pipe.(map[string]any); ok {
		if t, _ := m["type"].(string); t == "subscribe" || t == "unsubscribe" {
			s.handleDataChannelMessage(m, uuid)
		}
	}
	s.emit(Event{Type: EventDataReceived, UUID: uuid, Data: pipe, Fallback: true, Raw: msg})
}
