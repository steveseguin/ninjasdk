// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// Connection is one WebRTC peer connection in one direction. A peer UUID can
// have both a "publisher" connection (we send our stream to them) and a
// "viewer" connection (we receive their stream).
type Connection struct {
	sdk  *SDK
	uuid string
	typ  string // "publisher" | "viewer"
	pc   *webrtc.PeerConnection

	mediaMu       sync.Mutex
	infoSent      bool
	mu            sync.Mutex
	control       *webrtc.DataChannel
	channels      map[string]*webrtc.DataChannel
	streamID      string
	session       string
	info          map[string]any
	obsState      map[string]any
	allowAudio    bool
	allowVideo    bool
	allowDownload bool
	allowResource bool
	viewOptions   ViewOptions
	senders       []*webrtc.RTPSender
	senderKinds   map[*webrtc.RTPSender]webrtc.RTPCodecType // survives ReplaceTrack(nil)

	iceBundle      []webrtc.ICECandidateInit
	iceTimer       *time.Timer
	iceBundleDelay time.Duration

	pendingPing   int64
	missedPings   int
	pingTicker    *time.Ticker
	pingStop      chan struct{}
	connectTimer  *time.Timer
	disconnectTmr *time.Timer
	connectedOnce bool
	finalized     bool
	recovering    bool
	advertised    map[string]bool
	lastMessage   time.Time
}

// UUID of the remote peer.
func (c *Connection) UUID() string { return c.uuid }

// Type is "publisher" or "viewer".
func (c *Connection) Type() string { return c.typ }

// StreamID carried by this connection: our stream for publisher connections,
// the remote publisher's stream for viewer connections.
func (c *Connection) StreamID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.streamID
}

// PeerConnection exposes the underlying pion peer connection (for RTCP, stats
// or additional transceivers).
func (c *Connection) PeerConnection() *webrtc.PeerConnection { return c.pc }

// Info returns remote metadata received on the control channel (label, meta...).
func (c *Connection) Info() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]any, len(c.info))
	for k, v := range c.info {
		out[k] = v
	}
	return out
}

// Session is the WebRTC session ID negotiated for this connection.
func (c *Connection) Session() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.session
}

// ControlChannel returns the "sendChannel" data channel, or nil.
func (c *Connection) ControlChannel() *webrtc.DataChannel {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.control
}

// Channel returns the data channel with the given label, or nil.
func (c *Connection) Channel(label string) *webrtc.DataChannel {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.channels[label]
}

func (c *Connection) controlOpen() bool {
	c.mu.Lock()
	dc := c.control
	c.mu.Unlock()
	return dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen
}

// controlBuffered reports bytes still queued on the control channel.
func (c *Connection) controlBuffered() uint64 {
	c.mu.Lock()
	dc := c.control
	c.mu.Unlock()
	if dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen {
		return 0
	}
	return dc.BufferedAmount()
}

// sendControl sends a JSON message on the control channel. It returns false
// when the channel is not open.
func (c *Connection) sendControl(v any) bool {
	c.mu.Lock()
	dc := c.control
	c.mu.Unlock()
	if dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen {
		return false
	}
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	c.sdk.logf("-> DC(%s/%s) %s", c.uuid, c.typ, truncate(string(b), 300))
	return dc.SendText(string(b)) == nil
}

func (c *Connection) close() {
	c.mu.Lock()
	c.finalized = true
	if c.iceTimer != nil {
		c.iceTimer.Stop()
	}
	if c.connectTimer != nil {
		c.connectTimer.Stop()
	}
	if c.disconnectTmr != nil {
		c.disconnectTmr.Stop()
	}
	if c.pingStop != nil {
		close(c.pingStop)
		c.pingStop = nil
	}
	c.mu.Unlock()
	_ = c.pc.Close()
}

func (s *SDK) findConnection(uuid, typ string) *Connection {
	s.mu.Lock()
	defer s.mu.Unlock()
	pair := s.connections[uuid]
	if pair == nil {
		return nil
	}
	switch typ {
	case "publisher":
		return pair.publisher
	case "viewer":
		return pair.viewer
	}
	if pair.publisher != nil {
		return pair.publisher
	}
	return pair.viewer
}

func (s *SDK) isCurrent(c *Connection) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	pair := s.connections[c.uuid]
	if pair == nil {
		return false
	}
	return pair.publisher == c || pair.viewer == c
}

// createConnection builds a peer connection for uuid, replacing any existing
// connection of the same type.
func (s *SDK) createConnection(uuid, typ string) (*Connection, error) {
	cfg := s.iceConfiguration(context.Background())
	pc, err := s.api.NewPeerConnection(cfg)
	if err != nil {
		return nil, err
	}
	c := &Connection{
		sdk:            s,
		uuid:           uuid,
		typ:            typ,
		pc:             pc,
		channels:       map[string]*webrtc.DataChannel{},
		info:           map[string]any{},
		obsState:       map[string]any{},
		allowAudio:     false,
		allowVideo:     false,
		iceBundleDelay: 70 * time.Millisecond,
		advertised:     map[string]bool{},
		senderKinds:    map[*webrtc.RTPSender]webrtc.RTPCodecType{},
		lastMessage:    time.Now(),
	}

	pc.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil {
			return
		}
		s.handleLocalCandidate(c, cand.ToJSON())
	})
	pc.OnICEConnectionStateChange(func(webrtc.ICEConnectionState) { s.handlePeerState(c) })
	pc.OnConnectionStateChange(func(webrtc.PeerConnectionState) { s.handlePeerState(c) })
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		s.logf("Track received: %s from %s", track.Kind(), uuid)
		s.emit(Event{Type: EventTrack, UUID: uuid, StreamID: c.StreamID(), ConnectionType: typ, Track: track, Receiver: receiver})
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) { s.handleIncomingChannel(c, dc) })

	if typ == "publisher" {
		ordered := true
		dc, err := pc.CreateDataChannel(ControlChannelLabel, &webrtc.DataChannelInit{Ordered: &ordered})
		if err != nil {
			_ = pc.Close()
			return nil, err
		}
		c.mu.Lock()
		c.control = dc
		c.channels[ControlChannelLabel] = dc
		c.mu.Unlock()
		s.setupControlChannel(c, dc)
	}

	var old *Connection
	s.mu.Lock()
	pair := s.connections[uuid]
	if pair == nil {
		pair = &peerPair{}
		s.connections[uuid] = pair
	}
	if typ == "publisher" {
		old = pair.publisher
		pair.publisher = c
	} else {
		old = pair.viewer
		pair.viewer = c
	}
	s.mu.Unlock()
	if old != nil {
		s.logf("Replacing existing %s connection to %s", typ, uuid)
		old.close()
	}

	c.connectTimer = time.AfterFunc(s.opts.ConnectionTimeout, func() {
		if !s.isCurrent(c) {
			return
		}
		st := pc.ConnectionState()
		ice := pc.ICEConnectionState()
		if st != webrtc.PeerConnectionStateConnected && ice != webrtc.ICEConnectionStateConnected && ice != webrtc.ICEConnectionStateCompleted {
			s.recoverConnection(c, "connect-timeout")
		}
	})
	return c, nil
}

// createOffer establishes the control channel; viewer preferences add media later.
func (s *SDK) createOffer(c *Connection, iceRestart bool) (webrtc.SessionDescription, error) {
	var opts *webrtc.OfferOptions
	if iceRestart {
		opts = &webrtc.OfferOptions{ICERestart: true}
	}
	offer, err := c.pc.CreateOffer(opts)
	if err != nil {
		return offer, err
	}
	if err := c.pc.SetLocalDescription(offer); err != nil {
		return offer, err
	}
	return offer, nil
}

// drainRTCP reads and discards RTCP so the interceptor pipeline keeps flowing.
func (s *SDK) drainRTCP(sender *webrtc.RTPSender) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := sender.Read(buf); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) {
				return
			}
			return
		}
	}
}

// sendDescription sends an offer or answer, encrypted when a password is set.
// Offers also include our hashed stream ID. It uses the control channel when
// open (renegotiation) and the signaling server otherwise; viaSignaling forces
// the signaling server, for ICE restarts whose data channel may be dead.
func (s *SDK) sendDescription(c *Connection, desc webrtc.SessionDescription, includeStreamID, viaSignaling bool) {
	msg := map[string]any{"UUID": c.uuid, "session": c.Session()}
	if includeStreamID {
		s.mu.Lock()
		msg["streamID"] = s.hashedStreamID(c.streamID)
		s.mu.Unlock()
	}
	if _, ok := s.effectivePassword(); ok {
		enc, iv, err := s.encrypt(desc)
		if err != nil {
			s.emit(Event{Type: EventError, Err: err, UUID: c.uuid, Message: "failed to encrypt description"})
			return
		}
		msg["description"] = enc
		msg["vector"] = iv
	} else {
		msg["description"] = desc
	}
	if !viaSignaling && c.controlOpen() {
		dcMsg := map[string]any{"description": msg["description"], "session": msg["session"]}
		if desc.Type == webrtc.SDPTypeOffer && c.StreamID() != "" {
			dcMsg["streamID"] = c.StreamID()
		}
		if v, ok := msg["vector"]; ok {
			dcMsg["vector"] = v
		}
		if c.sendControl(dcMsg) {
			return
		}
	}
	s.sendWS(msg)
}

func (s *SDK) decodeDescription(msg map[string]any) (webrtc.SessionDescription, bool) {
	var desc webrtc.SessionDescription
	switch v := msg["description"].(type) {
	case string:
		iv := getString(msg, "vector")
		if iv == "" {
			return desc, false
		}
		if err := s.decryptInto(v, iv, &desc); err != nil {
			s.logf("Failed to decrypt description: %v", err)
			return desc, false
		}
	case map[string]any:
		b, _ := json.Marshal(v)
		if err := json.Unmarshal(b, &desc); err != nil {
			return desc, false
		}
	default:
		return desc, false
	}
	return desc, desc.SDP != ""
}

// handleSDP processes an offer or answer from the signaling server or a data channel.
func (s *SDK) handleSDP(msg map[string]any, via *Connection) {
	desc, ok := s.decodeDescription(msg)
	if !ok {
		return
	}
	uuid := getString(msg, "UUID")
	session := getString(msg, "session")
	if via != nil {
		uuid = via.uuid
		if session == "" {
			session = via.Session()
		}
	}
	switch desc.Type {
	case webrtc.SDPTypeOffer:
		s.handleOffer(uuid, session, msg, desc, via)
	case webrtc.SDPTypeAnswer:
		s.handleAnswer(uuid, session, desc)
	}
}

func (s *SDK) handleOffer(uuid, session string, msg map[string]any, desc webrtc.SessionDescription, via *Connection) {
	s.mu.Lock()
	var clean string
	hasStream := false
	if raw, ok := msg["streamID"].(string); ok {
		clean = s.stripHash(raw)
		hasStream = true
	}
	pair := s.connections[uuid]
	var c *Connection
	if pair != nil {
		c = pair.viewer
	}
	if via != nil && via.typ == "viewer" {
		c = via
	}
	if c != nil && c.Session() != "" && session != "" && c.Session() != session {
		s.logf("Session mismatch for %s (%s vs %s): replacing viewer connection", uuid, c.Session(), session)
		old := c
		pair.viewer = nil
		c = nil
		s.mu.Unlock()
		old.close()
		s.mu.Lock()
	}
	var opts ViewOptions
	havePending := false
	if c == nil && hasStream {
		opts, havePending = s.pendingViews[clean]
		if !havePending {
			opts, havePending = s.viewIntent[clean]
		}
	}
	s.mu.Unlock()

	if c == nil {
		var err error
		c, err = s.createConnection(uuid, "viewer")
		if err != nil {
			s.emit(Event{Type: EventError, Err: err, UUID: uuid})
			return
		}
		c.mu.Lock()
		c.session = session
		if hasStream {
			c.streamID = clean
		}
		if havePending {
			c.viewOptions = opts
		} else {
			c.viewOptions = ViewOptions{}
		}
		c.mu.Unlock()
		s.mu.Lock()
		if info := s.streams[clean]; info != nil && clean != "" {
			info.UUID = uuid
		}
		s.mu.Unlock()
	} else {
		c.mu.Lock()
		if c.session == "" {
			c.session = session
		}
		if c.streamID == "" && hasStream {
			c.streamID = clean
		}
		c.mu.Unlock()
	}

	if err := c.pc.SetRemoteDescription(desc); err != nil {
		s.logf("SetRemoteDescription(offer) failed: %v", err)
		s.emit(Event{Type: EventError, Err: err, UUID: uuid, Message: "failed to handle offer"})
		return
	}
	s.drainPendingICE(c, "local")
	answer, err := c.pc.CreateAnswer(nil)
	if err == nil {
		err = c.pc.SetLocalDescription(answer)
	}
	if err != nil {
		s.emit(Event{Type: EventError, Err: err, UUID: uuid, Message: "failed to create answer"})
		return
	}
	// Answer echoes the publisher's session and stream ID.
	out := map[string]any{"UUID": uuid, "session": session}
	if raw, ok := msg["streamID"]; ok {
		out["streamID"] = raw
	}
	if _, ok := s.effectivePassword(); ok {
		enc, iv, err := s.encrypt(answer)
		if err != nil {
			s.emit(Event{Type: EventError, Err: err, UUID: uuid})
			return
		}
		out["description"] = enc
		out["vector"] = iv
	} else {
		out["description"] = answer
	}
	if c.controlOpen() {
		dcMsg := map[string]any{"description": out["description"]}
		if v, ok := out["vector"]; ok {
			dcMsg["vector"] = v
		}
		c.sendControl(dcMsg)
	} else {
		s.sendWS(out)
	}

	// Wake up View() callers waiting for this stream.
	if hasStream && clean != "" {
		s.mu.Lock()
		waiters := s.viewWaiters[clean]
		delete(s.viewWaiters, clean)
		delete(s.pendingViews, clean)
		s.mu.Unlock()
		for _, w := range waiters {
			w <- c
		}
	}
}

func (s *SDK) handleAnswer(uuid, session string, desc webrtc.SessionDescription) {
	c := s.findConnection(uuid, "publisher")
	if c == nil {
		c = s.findConnection(uuid, "")
	}
	if c == nil {
		s.logf("No connection for answer from %s", uuid)
		return
	}
	if session != "" && c.Session() != "" && session != c.Session() {
		s.logf("Session mismatch, ignoring answer from %s", uuid)
		return
	}
	if err := c.pc.SetRemoteDescription(desc); err != nil {
		s.logf("SetRemoteDescription(answer) failed: %v", err)
		s.emit(Event{Type: EventError, Err: err, UUID: uuid, Message: "failed to handle answer"})
		return
	}
	s.drainPendingICE(c, "remote")
}

// renegotiate creates a new offer on a publisher connection (track changes or
// ICE restart) and sends it over the control channel or signaling.
func (s *SDK) renegotiate(c *Connection, iceRestart, viaSignaling bool) error {
	var opts *webrtc.OfferOptions
	if iceRestart {
		opts = &webrtc.OfferOptions{ICERestart: true}
	}
	offer, err := c.pc.CreateOffer(opts)
	if err != nil {
		return err
	}
	if err := c.pc.SetLocalDescription(offer); err != nil {
		return err
	}
	s.sendDescription(c, offer, true, viaSignaling)
	return nil
}

// restartICE performs the publisher-owned ICE restart, or asks the publisher
// for one when called on a viewer connection.
func (s *SDK) restartICE(c *Connection, reason string) {
	if c.typ == "viewer" {
		if c.sendControl(map[string]any{"iceRestartRequest": true}) {
			s.emit(Event{Type: EventICERestart, UUID: c.uuid, StreamID: c.StreamID(), Reason: reason})
		}
		return
	}
	// A restart we initiate because the connection failed must travel over
	// signaling: the data channel it would otherwise use is the thing that is
	// broken. Only a restart answering the peer's iceRestartRequest uses it.
	if err := s.renegotiate(c, true, reason != "remote_request"); err != nil {
		s.logf("ICE restart failed for %s: %v", c.uuid, err)
		return
	}
	s.emit(Event{Type: EventICERestart, UUID: c.uuid, StreamID: c.StreamID(), Reason: reason})
}

// ---------------------------------------------------------------------------
// ICE candidates
// ---------------------------------------------------------------------------

func (s *SDK) handleLocalCandidate(c *Connection, cand webrtc.ICECandidateInit) {
	// Viewers send type "remote" (toward the publisher's pcs); publishers send "local".
	msgType := "local"
	if c.typ == "viewer" {
		msgType = "remote"
	}
	if c.controlOpen() {
		msg := map[string]any{"type": msgType, "UUID": c.uuid, "session": c.Session()}
		if _, ok := s.effectivePassword(); ok {
			enc, iv, err := s.encrypt([]webrtc.ICECandidateInit{cand})
			if err != nil {
				s.emit(Event{Type: EventError, Err: err, UUID: c.uuid})
				return
			}
			msg["candidates"] = enc
			msg["vector"] = iv
		} else {
			msg["candidates"] = []webrtc.ICECandidateInit{cand}
		}
		if c.sendControl(msg) {
			return
		}
	}
	c.mu.Lock()
	c.iceBundle = append(c.iceBundle, cand)
	if c.iceTimer != nil {
		c.mu.Unlock()
		return
	}
	delay := c.iceBundleDelay
	c.iceBundleDelay *= 2
	if c.iceBundleDelay > time.Second {
		c.iceBundleDelay = time.Second
	}
	c.iceTimer = time.AfterFunc(delay, func() {
		c.mu.Lock()
		c.iceTimer = nil
		bundle := c.iceBundle
		c.iceBundle = nil
		finalized := c.finalized
		c.mu.Unlock()
		if finalized || len(bundle) == 0 {
			return
		}
		msg := map[string]any{"UUID": c.uuid, "type": msgType, "session": c.Session()}
		if _, ok := s.effectivePassword(); ok {
			enc, iv, err := s.encrypt(bundle)
			if err != nil {
				s.emit(Event{Type: EventError, Err: err, UUID: c.uuid, Message: "failed to encrypt ICE candidates"})
				return
			}
			msg["candidates"] = enc
			msg["vector"] = iv
		} else {
			msg["candidates"] = bundle
		}
		s.sendWS(msg)
	})
	c.mu.Unlock()
}

func (s *SDK) decodeCandidates(msg map[string]any, single bool) []webrtc.ICECandidateInit {
	key := "candidates"
	if single {
		key = "candidate"
	}
	var list []webrtc.ICECandidateInit
	switch v := msg[key].(type) {
	case string:
		iv := getString(msg, "vector")
		if iv == "" {
			return nil
		}
		if single {
			var one webrtc.ICECandidateInit
			if err := s.decryptInto(v, iv, &one); err != nil {
				s.logf("Failed to decrypt candidate: %v", err)
				return nil
			}
			list = []webrtc.ICECandidateInit{one}
		} else if err := s.decryptInto(v, iv, &list); err != nil {
			s.logf("Failed to decrypt candidates: %v", err)
			return nil
		}
	case map[string]any:
		b, _ := json.Marshal(v)
		var one webrtc.ICECandidateInit
		if json.Unmarshal(b, &one) == nil {
			list = []webrtc.ICECandidateInit{one}
		}
	case []any:
		b, _ := json.Marshal(v)
		_ = json.Unmarshal(b, &list)
	}
	out := list[:0]
	for _, c := range list {
		if c.Candidate != "" {
			out = append(out, c)
		}
	}
	return out
}

func (s *SDK) handleRemoteCandidates(msg map[string]any, via *Connection, single bool) {
	cands := s.decodeCandidates(msg, single)
	if len(cands) == 0 {
		return
	}
	uuid := getString(msg, "UUID")
	if via != nil {
		uuid = via.uuid
	}
	msgType := getString(msg, "type")
	var c *Connection
	switch msgType {
	case "remote":
		c = s.findConnection(uuid, "publisher")
	case "local":
		c = s.findConnection(uuid, "viewer")
	default:
		if via != nil {
			c = via
		} else {
			c = s.findConnection(uuid, "")
		}
	}
	session := getString(msg, "session")
	if c == nil || c.pc.RemoteDescription() == nil {
		s.queuePendingICE(uuid, msgType, session, cands)
		return
	}
	if session != "" && c.Session() != "" && session != c.Session() {
		s.logf("Session mismatch, ignoring candidates from %s", uuid)
		return
	}
	for _, cand := range cands {
		if err := c.pc.AddICECandidate(cand); err != nil {
			s.logf("AddICECandidate failed: %v", err)
		}
	}
}

func (s *SDK) queuePendingICE(uuid, msgType, session string, cands []webrtc.ICECandidateInit) {
	if uuid == "" || (msgType != "local" && msgType != "remote") {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := msgType + ":" + uuid
	now := time.Now()
	queue := s.pendingICE[key]
	for _, cand := range cands {
		queue = append(queue, pendingCandidate{candidate: cand, session: session, ts: now})
	}
	if len(queue) > 100 {
		queue = queue[len(queue)-100:]
	}
	s.pendingICE[key] = queue
	s.logf("Queued %d ICE candidate(s) before peer connection ready: %s (%s)", len(cands), uuid, msgType)
}

func (s *SDK) drainPendingICE(c *Connection, msgType string) {
	s.mu.Lock()
	key := msgType + ":" + c.uuid
	queue := s.pendingICE[key]
	delete(s.pendingICE, key)
	s.mu.Unlock()
	for _, item := range queue {
		if time.Since(item.ts) > 15*time.Second {
			continue
		}
		if item.session != "" && c.Session() != "" && item.session != c.Session() {
			continue
		}
		if err := c.pc.AddICECandidate(item.candidate); err != nil {
			s.logf("AddICECandidate (queued) failed: %v", err)
		}
	}
}

// ---------------------------------------------------------------------------
// Peer connection state
// ---------------------------------------------------------------------------

func (s *SDK) handlePeerState(c *Connection) {
	if !s.isCurrent(c) {
		return
	}
	peer := c.pc.ConnectionState()
	ice := c.pc.ICEConnectionState()
	var state string
	switch {
	case peer == webrtc.PeerConnectionStateFailed || ice == webrtc.ICEConnectionStateFailed:
		state = "failed"
	case peer == webrtc.PeerConnectionStateDisconnected || ice == webrtc.ICEConnectionStateDisconnected:
		state = "disconnected"
	case peer == webrtc.PeerConnectionStateConnected || ice == webrtc.ICEConnectionStateConnected || ice == webrtc.ICEConnectionStateCompleted:
		state = "connected"
	case peer == webrtc.PeerConnectionStateClosed:
		state = "closed"
	default:
		return
	}
	s.logf("Peer state for %s/%s: %s", c.uuid, c.typ, state)
	switch state {
	case "connected":
		c.mu.Lock()
		if c.connectTimer != nil {
			c.connectTimer.Stop()
		}
		if c.disconnectTmr != nil {
			c.disconnectTmr.Stop()
			c.disconnectTmr = nil
		}
		first := !c.connectedOnce
		c.connectedOnce = true
		c.recovering = false
		sid := c.streamID
		c.mu.Unlock()
		s.setStreamState(sid, "connected")
		if first {
			s.emit(Event{Type: EventPeerConnected, UUID: c.uuid, StreamID: sid, ConnectionType: c.typ})
		}
	case "disconnected":
		s.setStreamState(c.StreamID(), "disconnected")
		c.mu.Lock()
		if c.disconnectTmr == nil {
			c.disconnectTmr = time.AfterFunc(s.opts.DisconnectGracePeriod, func() {
				c.mu.Lock()
				c.disconnectTmr = nil
				c.mu.Unlock()
				if !s.isCurrent(c) {
					return
				}
				ice := c.pc.ICEConnectionState()
				if c.pc.ConnectionState() != webrtc.PeerConnectionStateConnected && ice != webrtc.ICEConnectionStateConnected && ice != webrtc.ICEConnectionStateCompleted {
					s.recoverConnection(c, "disconnected")
				}
			})
		}
		c.mu.Unlock()
	case "failed":
		s.setStreamState(c.StreamID(), "failed")
		s.recoverConnection(c, "failed")
	case "closed":
		// Closed by the remote side; our own close sets finalized first and
		// its caller reports the disconnect.
		c.mu.Lock()
		finalized := c.finalized
		c.mu.Unlock()
		if !finalized && s.isCurrent(c) {
			s.failConnection(c, "closed")
		}
	}
}

func (s *SDK) setStreamState(streamID, state string) {
	if streamID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if info := s.streams[streamID]; info != nil {
		info.State = state
	}
}

// recoverConnection attempts an ICE restart (publisher side), asks the
// publisher for one (viewer side), or re-requests the stream when nothing is
// open. Recovery is bounded: a second failure tears the connection down via
// failConnection, which reports peerDisconnected and connectionFailed.
func (s *SDK) recoverConnection(c *Connection, reason string) {
	if !s.isCurrent(c) {
		return
	}
	c.mu.Lock()
	if c.recovering {
		c.mu.Unlock()
		s.failConnection(c, reason)
		return
	}
	c.recovering = true
	c.mu.Unlock()
	s.logf("Recovering %s connection to %s (%s)", c.typ, c.uuid, reason)
	if c.typ == "publisher" || c.controlOpen() {
		s.restartICE(c, reason)
		s.armRecoveryTimer(c)
		return
	}
	// Nothing to talk over: start again from the play request.
	s.failConnection(c, reason)
}

// armRecoveryTimer bounds an ICE restart: if the connection is still down
// after ConnectionTimeout it is given up on.
func (s *SDK) armRecoveryTimer(c *Connection) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.connectTimer != nil {
		c.connectTimer.Stop()
	}
	c.connectTimer = time.AfterFunc(s.opts.ConnectionTimeout, func() {
		if !s.isCurrent(c) {
			return
		}
		st := c.pc.ConnectionState()
		ice := c.pc.ICEConnectionState()
		if st != webrtc.PeerConnectionStateConnected && ice != webrtc.ICEConnectionStateConnected && ice != webrtc.ICEConnectionStateCompleted {
			s.recoverConnection(c, "restart_timeout")
		}
	})
}

// failConnection closes and forgets a connection that could not be recovered,
// like the JS SDK's _handleConnectionFailed: peerDisconnected, then
// connectionFailed, then (viewer side) a retry of the view.
func (s *SDK) failConnection(c *Connection, reason string) {
	c.mu.Lock()
	sid, opts := c.streamID, c.viewOptions
	c.mu.Unlock()
	s.mu.Lock()
	if pair := s.connections[c.uuid]; pair != nil {
		if pair.viewer == c {
			pair.viewer = nil
		}
		if pair.publisher == c {
			pair.publisher = nil
		}
		if pair.publisher == nil && pair.viewer == nil {
			delete(s.connections, c.uuid)
		}
	}
	stopped := s.stoppedViews[sid]
	s.mu.Unlock()
	c.close()
	s.emit(Event{Type: EventPeerDisconnected, UUID: c.uuid, StreamID: sid, ConnectionType: c.typ})
	s.emit(Event{Type: EventConnectionFailed, UUID: c.uuid, StreamID: sid, ConnectionType: c.typ, Reason: reason})
	if c.typ == "viewer" && sid != "" && !stopped {
		s.scheduleViewRetry(sid, opts, 2*time.Second)
	}
}

// ---------------------------------------------------------------------------
// Data channels
// ---------------------------------------------------------------------------

func (s *SDK) handleIncomingChannel(c *Connection, dc *webrtc.DataChannel) {
	label := dc.Label()
	s.logf("Data channel from %s: %q", c.uuid, label)
	c.mu.Lock()
	c.channels[label] = dc
	c.mu.Unlock()
	dc.OnClose(func() {
		c.mu.Lock()
		if c.channels[label] == dc {
			delete(c.channels, label)
		}
		c.mu.Unlock()
	})
	if label == "" || label == ControlChannelLabel {
		c.mu.Lock()
		c.control = dc
		c.mu.Unlock()
		s.setupControlChannel(c, dc)
		return
	}
	switch {
	case label == ChunkedChannelLabel:
		s.emit(Event{Type: EventUnsupportedChan, UUID: c.uuid, StreamID: c.StreamID(), Label: label, Channel: dc})
	case label == ResourcesChannelLabel:
		s.setupResourceChannel(c, dc)
	case strings.HasPrefix(label, ReservedChannelPrefix):
		if label == BinaryChannelLabel {
			s.setupBinaryChannel(c, dc)
		} else {
			s.setupReservedChannel(c, dc)
		}
	default:
		s.setupFileReceiveChannel(c, dc, label)
	}
}

func (s *SDK) setupControlChannel(c *Connection, dc *webrtc.DataChannel) {
	dc.OnOpen(func() {
		s.logf("Control channel open for %s/%s", c.uuid, c.typ)
		if c.typ == "viewer" {
			c.mu.Lock()
			o := c.viewOptions
			c.mu.Unlock()
			prefs := map[string]any{"audio": o.audio(), "video": o.video(), "downloads": o.downloads(), "info": map[string]any{}}
			if o.Label != "" {
				prefs["info"] = map[string]any{"label": o.Label}
			}
			if o.AllowResources {
				prefs["allowresources"] = true
			}
			c.sendControl(prefs)
		} else {
			s.mu.Lock()
			info := make(map[string]any, len(s.publisherInfo))
			for k, v := range s.publisherInfo {
				info[k] = v
			}
			s.mu.Unlock()
			if c.sendControl(map[string]any{"info": info}) {
				c.mu.Lock()
				c.infoSent = true
				c.mu.Unlock()
				s.updateTracksForConnection(c)
			}
		}
		s.startPingMonitor(c)
		s.emit(Event{Type: EventDataChannelOpen, UUID: c.uuid, StreamID: c.StreamID(), ConnectionType: c.typ, Channel: dc, Label: dc.Label()})
	})
	dc.OnClose(func() {
		c.mu.Lock()
		if c.pingStop != nil {
			close(c.pingStop)
			c.pingStop = nil
		}
		c.mu.Unlock()
		s.emit(Event{Type: EventDataChannelClose, UUID: c.uuid, StreamID: c.StreamID(), ConnectionType: c.typ, Label: dc.Label()})
	})
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		c.mu.Lock()
		c.lastMessage = time.Now()
		c.mu.Unlock()
		if !m.IsString {
			// VDO.Ninja renders binary control-channel payloads as images; the SDK ignores them.
			return
		}
		var msg map[string]any
		if err := json.Unmarshal(m.Data, &msg); err != nil || msg == nil {
			return
		}
		s.logf("<- DC(%s/%s) %s", c.uuid, c.typ, truncate(string(m.Data), 300))
		s.handleControlMessage(c, msg)
	})
}

func (s *SDK) handleControlMessage(c *Connection, msg map[string]any) {
	// Independent keys first (VDO.Ninja checks them with separate "key in msg" tests).
	if list, ok := msg["fileList"].([]any); ok {
		files := parseFileEntries(list)
		s.emit(Event{Type: EventFileList, UUID: c.uuid, StreamID: c.StreamID(), Files: files})
	}
	switch v := msg["requestFile"].(type) {
	case string:
		s.handleFileRequest(c, v)
	case float64:
		s.handleFileRequest(c, jsonNumberString(v))
	}
	if d, ok := msg["downloads"]; ok {
		c.mu.Lock()
		c.allowDownload = d == true
		c.mu.Unlock()
		if c.typ == "publisher" && d == true {
			s.sendFileList(c)
		}
	}
	if r, ok := msg["allowresources"]; ok {
		c.mu.Lock()
		c.allowResource = r == true
		c.mu.Unlock()
	}
	if obs, ok := msg["obsState"].(map[string]any); ok {
		c.mu.Lock()
		for k, v := range obs {
			c.obsState[k] = v
		}
		snapshot := make(map[string]any, len(c.obsState))
		for k, v := range c.obsState {
			snapshot[k] = v
		}
		c.mu.Unlock()
		s.emit(Event{Type: EventOBSState, UUID: c.uuid, StreamID: c.StreamID(), Data: snapshot, Raw: obs})
	}
	if info, ok := msg["info"].(map[string]any); ok {
		c.mu.Lock()
		for k, v := range info {
			c.info[k] = v
		}
		snapshot := make(map[string]any, len(c.info))
		for k, v := range c.info {
			snapshot[k] = v
		}
		c.mu.Unlock()
		s.emit(Event{Type: EventPeerInfo, UUID: c.uuid, StreamID: c.StreamID(), Info: snapshot})
	}

	switch {
	case msg["description"] != nil:
		s.handleSDP(msg, c)
	case msg["candidate"] != nil:
		s.handleRemoteCandidates(msg, c, true)
	case msg["candidates"] != nil:
		s.handleRemoteCandidates(msg, c, false)
	case isBool(msg["audio"]) || isBool(msg["video"]):
		c.mu.Lock()
		if a, ok := msg["audio"].(bool); ok {
			c.allowAudio = a
		}
		if v, ok := msg["video"].(bool); ok {
			c.allowVideo = v
		}
		c.mu.Unlock()
		s.updateTracksForConnection(c)
	case msg["ping"] != nil:
		c.sendControl(map[string]any{"pong": msg["ping"]})
	case msg["pong"] != nil:
		if ts, ok := msg["pong"].(float64); ok {
			latency := time.Now().UnixMilli() - int64(ts)
			c.mu.Lock()
			if c.pendingPing == int64(ts) {
				c.pendingPing = 0
				c.missedPings = 0
			}
			c.mu.Unlock()
			s.emit(Event{Type: EventPeerLatency, UUID: c.uuid, StreamID: c.StreamID(), Latency: latency})
		}
	case msg["bye"] != nil:
		s.handleBye(c.uuid, EventBye, msg)
	case hasKey(msg, "videoMuted"):
		muted, _ := msg["videoMuted"].(bool)
		s.emit(Event{Type: EventRemoteVideoMute, UUID: c.uuid, StreamID: c.StreamID(), ConnectionType: c.typ, Muted: muted, Raw: msg})
		s.emit(Event{Type: EventDataReceived, UUID: c.uuid, StreamID: c.StreamID(), Data: msg, Raw: msg})
	case msg["pipe"] != nil:
		if pm, ok := msg["pipe"].(map[string]any); ok {
			switch pm["type"] {
			case "subscribe", "unsubscribe", "channelMessage", "request", "response":
				s.handleDataChannelMessage(pm, c.uuid)
				return
			}
		}
		s.emit(Event{Type: EventDataReceived, UUID: c.uuid, StreamID: c.StreamID(), Data: msg["pipe"], Raw: msg})
	case msg["iceRestartRequest"] != nil:
		if c.typ == "publisher" {
			s.restartICE(c, "remote_request")
		}
	}
}

func isBool(v any) bool { _, ok := v.(bool); return ok }

func hasKey(m map[string]any, k string) bool { _, ok := m[k]; return ok }

func jsonNumberString(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}

// updateTracksForConnection applies viewer audio/video preferences to the
// publisher connection's senders by replacing tracks with nil (muted) or the
// local track again.
func (s *SDK) updateTracksForConnection(c *Connection) {
	if c.typ != "publisher" {
		return
	}
	c.mediaMu.Lock()
	defer c.mediaMu.Unlock()
	c.mu.Lock()
	ready := c.infoSent
	c.mu.Unlock()
	if !ready || !c.controlOpen() {
		return
	}

	s.mu.Lock()
	tracks := append([]webrtc.TrackLocal(nil), s.localTracks...)
	s.mu.Unlock()
	if len(tracks) == 0 {
		return
	}
	c.mu.Lock()
	senders := append([]*webrtc.RTPSender(nil), c.senders...)
	allowAudio, allowVideo := c.allowAudio, c.allowVideo
	c.mu.Unlock()
	for _, sender := range senders {
		c.mu.Lock()
		k, known := c.senderKinds[sender]
		c.mu.Unlock()
		if !known {
			// A muted sender has no track; the recorded kind is what lets it resume.
			if t := sender.Track(); t != nil {
				k = t.Kind()
			} else {
				continue
			}
		}
		allow := (k == webrtc.RTPCodecTypeAudio && allowAudio) || (k == webrtc.RTPCodecTypeVideo && allowVideo)
		if !allow {
			if sender.Track() != nil {
				if err := sender.ReplaceTrack(nil); err != nil {
					s.logf("ReplaceTrack(nil) failed: %v", err)
				}
			}
			continue
		}
		if sender.Track() != nil {
			continue // already sending this kind
		}
		for _, t := range tracks {
			if t.Kind() == k {
				if err := sender.ReplaceTrack(t); err != nil {
					s.logf("ReplaceTrack failed: %v", err)
				}
				break
			}
		}
	}
	changed := false
	for _, track := range tracks {
		kind := track.Kind()
		if (kind == webrtc.RTPCodecTypeAudio && !allowAudio) || (kind == webrtc.RTPCodecTypeVideo && !allowVideo) {
			continue
		}
		found := false
		c.mu.Lock()
		for _, k := range c.senderKinds {
			if k == kind {
				found = true
				break
			}
		}
		c.mu.Unlock()
		if found {
			continue
		}
		sender, err := c.pc.AddTrack(track)
		if err != nil {
			s.logf("AddTrack failed: %v", err)
			continue
		}
		c.mu.Lock()
		c.senders = append(c.senders, sender)
		c.senderKinds[sender] = kind
		c.mu.Unlock()
		go s.drainRTCP(sender)
		changed = true
	}
	if changed {
		if err := s.renegotiate(c, false, false); err != nil {
			s.logf("media offer failed: %v", err)
		}
	}

}

// ---------------------------------------------------------------------------
// Ping monitoring
// ---------------------------------------------------------------------------

func (s *SDK) startPingMonitor(c *Connection) {
	if !s.opts.AutoPingViewer || c.typ != "viewer" {
		return
	}
	c.mu.Lock()
	if c.pingStop != nil {
		close(c.pingStop)
	}
	stop := make(chan struct{})
	c.pingStop = stop
	c.mu.Unlock()
	interval := s.opts.AutoPingInterval
	if interval < time.Second {
		interval = time.Second
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
			}
			if !c.controlOpen() {
				continue
			}
			c.mu.Lock()
			pending := c.pendingPing
			c.mu.Unlock()
			if pending != 0 {
				elapsed := time.Duration(time.Now().UnixMilli()-pending) * time.Millisecond
				timeout := interval + 5*time.Second
				if interval*3/2 > timeout {
					timeout = interval * 3 / 2
				}
				if elapsed < timeout {
					continue
				}
				c.mu.Lock()
				c.missedPings++
				missed := c.missedPings
				c.pendingPing = 0
				c.mu.Unlock()
				if missed >= 2 {
					c.mu.Lock()
					c.missedPings = 0
					c.mu.Unlock()
					s.restartICE(c, "missed_pings")
					continue
				}
			}
			s.SendPing(c.uuid)
		}
	}()
}

// SendPing sends a ping on the control channel. The peer replies with pong and
// a peerLatency event is emitted. Pass "" to ping every peer.
func (s *SDK) SendPing(uuid string) bool {
	ts := time.Now().UnixMilli()
	s.mu.Lock()
	var conns []*Connection
	for id, pair := range s.connections {
		if uuid != "" && id != uuid {
			continue
		}
		for _, c := range []*Connection{pair.publisher, pair.viewer} {
			if c != nil {
				conns = append(conns, c)
			}
		}
	}
	s.mu.Unlock()
	for _, c := range conns {
		c.mu.Lock()
		c.pendingPing = ts
		c.mu.Unlock()
	}
	return s.sendDataInternal(map[string]any{"ping": ts}, uuid, "", "any")
}
