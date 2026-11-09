// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// SendData sends application data wrapped in VDO.Ninja's {"pipe": ...}
// envelope to every connected peer (publisher channel preferred, so a peer
// connected in both directions receives it once). It returns true when at
// least one channel accepted the message.
func (s *SDK) SendData(data any) bool {
	return s.SendDataWith(data, DataTarget{})
}

// SendDataTo sends data to one peer.
func (s *SDK) SendDataTo(uuid string, data any) bool {
	return s.SendDataWith(data, DataTarget{UUID: uuid})
}

// SendDataWith sends data with explicit routing.
func (s *SDK) SendDataWith(data any, t DataTarget) bool {
	msg := map[string]any{"pipe": data}
	pref := t.Preference
	switch pref {
	case "", "any", "pcs":
		pref = "any"
	case "rpcs":
		pref = "viewer"
	}
	typ := t.Type
	switch typ {
	case "pcs":
		typ = "publisher"
	case "rpcs":
		typ = "viewer"
	case "publisher", "viewer", "":
	default:
		typ = ""
	}
	if t.StreamID != "" && t.UUID == "" {
		s.mu.Lock()
		var uuids []string
		for uuid, pair := range s.connections {
			for _, c := range []*Connection{pair.publisher, pair.viewer} {
				if c == nil || (typ != "" && c.typ != typ) {
					continue
				}
				if c.StreamID() == t.StreamID {
					uuids = append(uuids, uuid)
					break
				}
			}
		}
		s.mu.Unlock()
		sent := false
		for _, uuid := range uuids {
			if s.sendDataInternal(msg, uuid, typ, pref) {
				sent = true
			}
		}
		return sent
	}
	return s.sendDataInternal(msg, t.UUID, typ, pref)
}

// sendDataInternal mirrors the JavaScript SDK's _sendDataInternal routing.
func (s *SDK) sendDataInternal(msg any, uuid, typ, preference string) bool {
	raw, err := json.Marshal(msg)
	if err != nil {
		return false
	}
	text := string(raw)
	s.mu.Lock()
	byUUID := map[string]*peerPair{}
	for id, pair := range s.connections {
		if uuid != "" && id != uuid {
			continue
		}
		byUUID[id] = &peerPair{publisher: pair.publisher, viewer: pair.viewer}
	}
	s.mu.Unlock()

	sent := false
	try := func(c *Connection) bool {
		if c == nil || (typ != "" && c.typ != typ) {
			return false
		}
		c.mu.Lock()
		dc := c.control
		c.mu.Unlock()
		if dc == nil || dc.ReadyState() != 2 /* open */ {
			return false
		}
		if err := dc.SendText(text); err != nil {
			s.logf("send on %s/%s failed: %v", c.uuid, c.typ, err)
			return false
		}
		s.logf("-> DC(%s/%s) %s", c.uuid, c.typ, truncate(text, 300))
		return true
	}
	for _, pair := range byUUID {
		switch preference {
		case "publisher":
			if try(pair.publisher) {
				sent = true
			}
		case "viewer":
			if try(pair.viewer) {
				sent = true
			}
		case "all":
			if try(pair.publisher) {
				sent = true
			}
			if try(pair.viewer) {
				sent = true
			}
		default:
			if try(pair.publisher) || try(pair.viewer) {
				sent = true
			}
		}
	}
	return sent
}

// ---------------------------------------------------------------------------
// Pub/Sub
// ---------------------------------------------------------------------------

// Subscribe joins pub/sub channels and tells connected peers.
func (s *SDK) Subscribe(channels ...string) {
	s.mu.Lock()
	for _, ch := range channels {
		s.subscriptions[ch] = true
	}
	connected := s.connected
	s.mu.Unlock()
	if connected {
		s.SendDataWith(map[string]any{"type": "subscribe", "channels": channels}, DataTarget{})
	}
}

// Unsubscribe leaves pub/sub channels.
func (s *SDK) Unsubscribe(channels ...string) {
	s.mu.Lock()
	for _, ch := range channels {
		delete(s.subscriptions, ch)
	}
	connected := s.connected
	s.mu.Unlock()
	if connected {
		s.SendDataWith(map[string]any{"type": "unsubscribe", "channels": channels}, DataTarget{})
	}
}

// Subscriptions lists local pub/sub subscriptions.
func (s *SDK) Subscriptions() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.subscriptions))
	for ch := range s.subscriptions {
		out = append(out, ch)
	}
	return out
}

// PeerSubscriptions lists the channels a peer told us it subscribed to.
func (s *SDK) PeerSubscriptions(uuid string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []string{}
	for ch := range s.peerSubs[uuid] {
		out = append(out, ch)
	}
	return out
}

// PublishToChannel sends a pub/sub message. Pass "" or "all" as target to
// reach every peer; receivers only surface it when subscribed to the channel.
func (s *SDK) PublishToChannel(channel string, data any, target string) bool {
	msg := map[string]any{"type": "channelMessage", "channel": channel, "data": data, "timestamp": time.Now().UnixMilli()}
	if target == "" || target == "all" {
		return s.SendData(msg)
	}
	return s.SendDataTo(target, msg)
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

// RequestHandler answers a request from a peer. Returning an error sends an
// error response.
type RequestHandler func(data any, fromUUID string) (any, error)

type pendingRequest struct {
	target string
	done   chan struct{}
	once   sync.Once
	result any
	err    error
}

func (p *pendingRequest) finish(result any, err error) {
	p.once.Do(func() {
		p.result = result
		p.err = err
		close(p.done)
	})
}

func (p *pendingRequest) fail(err error) { p.finish(nil, err) }

// OnRequest registers a handler for a request type.
func (s *SDK) OnRequest(requestType string, h RequestHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h == nil {
		delete(s.requestHandlers, requestType)
		return
	}
	s.requestHandlers[requestType] = h
}

// Request sends a request to a peer and waits for its response (default 5s
// timeout when ctx has no deadline).
func (s *SDK) Request(ctx context.Context, requestType string, data any, targetUUID string) (any, error) {
	if _, has := ctx.Deadline(); !has {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
	}
	id := generateUUID()
	p := &pendingRequest{target: targetUUID, done: make(chan struct{})}
	s.mu.Lock()
	s.pendingRequests[id] = p
	s.mu.Unlock()
	ok := s.SendDataTo(targetUUID, map[string]any{"type": "request", "requestType": requestType, "requestId": id, "data": data})
	if !ok {
		s.mu.Lock()
		delete(s.pendingRequests, id)
		s.mu.Unlock()
		return nil, ErrNoDataChannel
	}
	select {
	case <-p.done:
		return p.result, p.err
	case <-ctx.Done():
		s.mu.Lock()
		delete(s.pendingRequests, id)
		s.mu.Unlock()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("%w: %s", ErrRequestTimeout, requestType)
		}
		return nil, ctx.Err()
	}
}

// Respond sends a response to a request ID (for handlers that answer later).
func (s *SDK) Respond(requestID string, data any, targetUUID string) bool {
	return s.SendDataTo(targetUUID, map[string]any{"type": "response", "requestId": requestID, "data": data})
}

func (s *SDK) handleDataChannelMessage(data map[string]any, uuid string) {
	switch data["type"] {
	case "subscribe", "unsubscribe":
		var list []string
		switch v := data["channels"].(type) {
		case []any:
			for _, x := range v {
				if str, ok := x.(string); ok {
					list = append(list, str)
				}
			}
		case string:
			list = []string{v}
		}
		s.mu.Lock()
		set := s.peerSubs[uuid]
		if set == nil {
			set = map[string]bool{}
			s.peerSubs[uuid] = set
		}
		for _, ch := range list {
			if data["type"] == "subscribe" {
				set[ch] = true
			} else {
				delete(set, ch)
			}
		}
		all := make([]string, 0, len(set))
		for ch := range set {
			all = append(all, ch)
		}
		s.mu.Unlock()
		typ := EventPeerSubscribed
		if data["type"] == "unsubscribe" {
			typ = EventPeerUnsubscribed
		}
		s.emit(Event{Type: typ, UUID: uuid, Channels: list, Data: all})
	case "channelMessage":
		ch, _ := data["channel"].(string)
		s.mu.Lock()
		subscribed := s.subscriptions[ch]
		s.mu.Unlock()
		if subscribed {
			ts, _ := data["timestamp"].(float64)
			s.emit(Event{Type: EventChannelMessage, UUID: uuid, ChannelName: ch, Data: data["data"], Timestamp: int64(ts)})
		}
	case "request":
		rt, _ := data["requestType"].(string)
		rid, _ := data["requestId"].(string)
		s.mu.Lock()
		h := s.requestHandlers[rt]
		s.mu.Unlock()
		if h == nil || rid == "" {
			return
		}
		go func() {
			result, err := h(data["data"], uuid)
			if err != nil {
				s.Respond(rid, map[string]any{"error": err.Error()}, uuid)
				return
			}
			s.Respond(rid, result, uuid)
		}()
	case "response":
		rid, _ := data["requestId"].(string)
		s.mu.Lock()
		p := s.pendingRequests[rid]
		if p != nil && p.target != "" && p.target != uuid {
			p = nil
		}
		if p != nil {
			delete(s.pendingRequests, rid)
		}
		s.mu.Unlock()
		if p == nil {
			return
		}
		if m, ok := data["data"].(map[string]any); ok {
			if e, ok := m["error"].(string); ok && e != "" {
				p.fail(errors.New(e))
				return
			}
		}
		p.finish(data["data"], nil)
	default:
		s.emit(Event{Type: EventDataReceived, UUID: uuid, Data: data})
	}
}

// ---------------------------------------------------------------------------
// AutoConnect
// ---------------------------------------------------------------------------

// AutoConnectOptions configures AutoConnect.
type AutoConnectOptions struct {
	Room string
	// Mode "half" (default) gives one data channel per pair by letting only
	// the peer with the greater stream ID view the other; "full" views every
	// peer (needed for media exchange).
	Mode string
	// View overrides the requested tracks (default: none in half, both in full).
	View     *ViewOptions
	Label    string
	Password string
	StreamID string
	// Filter decides which discovered streams to view; nil views all.
	Filter func(streamID, uuid string) bool
}

// AutoConnectController stops discovery (existing connections stay open).
type AutoConnectController struct {
	StreamID string
	stop     func()
}

// Stop removes the discovery listeners.
func (a *AutoConnectController) Stop() { a.stop() }

// AutoConnect connects, joins the room, announces this peer and views the
// other peers in the room as they appear.
func (s *SDK) AutoConnect(ctx context.Context, o AutoConnectOptions) (*AutoConnectController, error) {
	if o.Room == "" {
		return nil, ErrRoomRequired
	}
	if o.Mode == "" {
		o.Mode = "half"
	}
	view := ViewOptions{Audio: Bool(o.Mode == "full"), Video: Bool(o.Mode == "full")}
	if o.View != nil {
		if o.View.Audio != nil {
			view.Audio = o.View.Audio
		}
		if o.View.Video != nil {
			view.Video = o.View.Video
		}
		view.Label = o.View.Label
		view.Downloads = o.View.Downloads
		view.AllowResources = o.View.AllowResources
	}
	var mu sync.Mutex
	myStreamID := ""
	viewed := map[string]bool{}

	consider := func(streamID, uuid string) {
		mu.Lock()
		mine := myStreamID
		mu.Unlock()
		if mine == "" || streamID == "" || streamID == mine {
			return
		}
		if o.Filter != nil && !o.Filter(streamID, uuid) {
			return
		}
		if o.Mode == "half" && !(streamID < mine) {
			return
		}
		mu.Lock()
		if viewed[streamID] {
			mu.Unlock()
			return
		}
		viewed[streamID] = true
		mu.Unlock()
		go func() {
			if _, err := s.View(context.Background(), streamID, view); err != nil && !errors.Is(err, ErrStreamNotYetAvailable) {
				mu.Lock()
				delete(viewed, streamID)
				mu.Unlock()
			}
		}()
	}
	offListing := s.On(EventListing, func(ev Event) {
		for _, e := range ev.List {
			consider(e.StreamID, e.UUID)
		}
	})
	offAdded := s.On(EventVideoAddedToRoom, func(ev Event) { consider(ev.StreamID, ev.UUID) })
	stop := func() { offListing(); offAdded() }

	if !s.Connected() {
		if err := s.Connect(ctx); err != nil {
			stop()
			return nil, err
		}
	}
	if s.Room() != SanitizeRoom(o.Room) {
		if err := s.JoinRoom(ctx, o.Room, JoinOptions{Password: o.Password}); err != nil {
			stop()
			return nil, err
		}
	}
	sid, err := s.Announce(ctx, PublishOptions{StreamID: o.StreamID, Label: o.Label})
	if err != nil {
		stop()
		return nil, err
	}
	mu.Lock()
	myStreamID = sid
	mu.Unlock()
	for _, info := range s.Streams() {
		consider(info.StreamID, info.UUID)
	}
	return &AutoConnectController{StreamID: sid, stop: stop}, nil
}
