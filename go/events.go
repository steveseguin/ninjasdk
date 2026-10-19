// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"sync"

	"github.com/pion/webrtc/v4"
)

// EventType names an SDK event. The names match the JavaScript SDK where an
// equivalent exists, so documentation and integrations translate directly.
type EventType string

const (
	EventConnected        EventType = "connected"
	EventDisconnected     EventType = "disconnected"
	EventReconnecting     EventType = "reconnecting"
	EventReconnected      EventType = "reconnected"
	EventReconnectFailed  EventType = "reconnectFailed"
	EventRoomJoined       EventType = "roomJoined"
	EventRoomLeft         EventType = "roomLeft"
	EventListing          EventType = "listing"
	EventVideoAddedToRoom EventType = "videoaddedtoroom"
	EventSomeoneJoined    EventType = "someoneJoined"
	EventTransferred      EventType = "transferred"
	EventPublishing       EventType = "publishing"
	EventPublishingStop   EventType = "publishingStopped"
	EventViewingStopped   EventType = "viewingStopped"
	EventPeerConnected    EventType = "peerConnected"
	EventPeerDisconnected EventType = "peerDisconnected"
	EventConnectionFailed EventType = "connectionFailed"
	EventICERestart       EventType = "iceRestart"
	EventDataChannelOpen  EventType = "dataChannelOpen"
	EventDataChannelClose EventType = "dataChannelClose"
	EventDataReceived     EventType = "dataReceived"
	EventPeerInfo         EventType = "peerInfo"
	EventPeerLatency      EventType = "peerLatency"
	EventRemoteVideoMute  EventType = "remoteVideoMuteState"
	EventOBSState         EventType = "obsState"
	EventTrack            EventType = "track"
	EventChannelMessage   EventType = "channelMessage"
	EventPeerSubscribed   EventType = "peerSubscribed"
	EventPeerUnsubscribed EventType = "peerUnsubscribed"
	EventChannelOpen      EventType = "channelOpen"
	EventBinaryReceived   EventType = "binaryReceived"
	EventBufferedLow      EventType = "bufferedAmountLow"
	EventFileList         EventType = "fileList"
	EventFileStart        EventType = "fileTransferStart"
	EventFileProgress     EventType = "fileTransferProgress"
	EventFileChunk        EventType = "fileChunk"
	EventFileComplete     EventType = "fileTransferComplete"
	EventFileCancelled    EventType = "fileTransferCancelled"
	EventFileError        EventType = "fileTransferError"
	EventResourceReceived EventType = "resourceReceived"
	EventUnsupportedChan  EventType = "unsupportedChannel"
	EventBye              EventType = "bye"
	EventHangup           EventType = "hangup"
	EventAlert            EventType = "alert"
	EventError            EventType = "error"
)

// Event is delivered to handlers registered with SDK.On. Only the fields
// relevant to the event type are populated.
type Event struct {
	Type EventType
	// UUID of the remote peer, when the event concerns one.
	UUID string
	// StreamID of the stream the event concerns.
	StreamID string
	// ConnectionType is "publisher" or "viewer" for per-connection events.
	ConnectionType string
	// Data carries decoded JSON (dataReceived, channelMessage, listing items...).
	Data any
	// Raw is the original signaling or control message.
	Raw map[string]any
	// Message is a human readable message (alert, error).
	Message string
	// Err is set for error events.
	Err error
	// Info is remote peer metadata (peerInfo).
	Info map[string]any
	// Latency in milliseconds (peerLatency).
	Latency int64
	// Muted is set for remoteVideoMuteState.
	Muted bool
	// Track and Receiver are set for track events.
	Track    *webrtc.TrackRemote
	Receiver *webrtc.RTPReceiver
	// Channel is set for channelOpen/dataChannelOpen events. Label is its label.
	Channel *webrtc.DataChannel
	Label   string
	// Bytes carries binary payloads (binaryReceived, fileChunk, resourceReceived).
	Bytes []byte
	// File describes a file transfer (file* events).
	File *FileTransferInfo
	// Files lists advertised files (fileList).
	Files []FileEntry
	// List holds room listing entries (listing).
	List []ListingEntry
	// Channels holds pub/sub channel names (peerSubscribed/peerUnsubscribed).
	Channels []string
	// ChannelName is the pub/sub channel (channelMessage).
	ChannelName string
	// Timestamp echoes the sender's timestamp (channelMessage).
	Timestamp int64
	// Intentional, WillReconnect and Reason describe disconnects.
	Intentional   bool
	WillReconnect bool
	Reason        string
	// Fallback marks data that arrived through the signaling relay.
	Fallback bool
	// BufferedAmount is set for bufferedAmountLow.
	BufferedAmount uint64
}

// ListingEntry is one peer in a room listing.
type ListingEntry struct {
	StreamID string `json:"streamID,omitempty"`
	UUID     string `json:"UUID,omitempty"`
	Label    string `json:"label,omitempty"`
	Director bool   `json:"director,omitempty"`
}

// Handler receives events.
type Handler func(Event)

type eventBus struct {
	mu       sync.RWMutex
	nextID   int
	handlers map[EventType]map[int]Handler
	any      map[int]Handler
}

func newEventBus() *eventBus {
	return &eventBus{handlers: make(map[EventType]map[int]Handler), any: make(map[int]Handler)}
}

// On registers a handler for one event type and returns a function that
// removes it again. Handlers run synchronously on the SDK's internal
// goroutines; do blocking work elsewhere.
func (s *SDK) On(t EventType, h Handler) (off func()) {
	return s.bus.on(t, h)
}

// OnAny registers a handler for every event.
func (s *SDK) OnAny(h Handler) (off func()) {
	return s.bus.onAny(h)
}

func (b *eventBus) on(t EventType, h Handler) func() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextID++
	id := b.nextID
	if b.handlers[t] == nil {
		b.handlers[t] = make(map[int]Handler)
	}
	b.handlers[t][id] = h
	return func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if m := b.handlers[t]; m != nil {
			delete(m, id)
		}
	}
}

func (b *eventBus) onAny(h Handler) func() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextID++
	id := b.nextID
	b.any[id] = h
	return func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		delete(b.any, id)
	}
}

func (b *eventBus) emit(ev Event) {
	b.mu.RLock()
	list := make([]Handler, 0, len(b.handlers[ev.Type])+len(b.any))
	for _, h := range b.handlers[ev.Type] {
		list = append(list, h)
	}
	for _, h := range b.any {
		list = append(list, h)
	}
	b.mu.RUnlock()
	for _, h := range list {
		h(ev)
	}
}

// emit dispatches an event. It must never be called while holding s.mu.
func (s *SDK) emit(ev Event) { s.bus.emit(ev) }
