// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

// ChannelOptions configures OpenChannel.
type ChannelOptions struct {
	// Ordered defaults to true.
	Ordered *bool
	// MaxRetransmits and MaxPacketLifeTime (ms) enable partial reliability;
	// they are mutually exclusive.
	MaxRetransmits    *uint16
	MaxPacketLifeTime *uint16
	Protocol          string
	// Timeout bounds the wait for the channel to open (default 15s).
	Timeout time.Duration
}

// OpenChannel opens an additional data channel to a peer in the reserved "x-"
// namespace, which VDO.Ninja peers ignore. The label gets the prefix when it
// is missing. It is idempotent: an existing open channel is returned.
func (s *SDK) OpenChannel(ctx context.Context, uuid, label string, opts ...ChannelOptions) (*webrtc.DataChannel, error) {
	var o ChannelOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	if label == "" {
		return nil, errors.New("vdoninja: channel label required")
	}
	if !strings.HasPrefix(label, ReservedChannelPrefix) {
		label = ReservedChannelPrefix + label
	}
	if o.MaxRetransmits != nil && o.MaxPacketLifeTime != nil {
		return nil, errors.New("vdoninja: maxRetransmits and maxPacketLifeTime are mutually exclusive")
	}
	if o.Timeout <= 0 {
		o.Timeout = 15 * time.Second
	}
	c := s.findConnection(uuid, "publisher")
	if c == nil || c.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
		c = s.findConnection(uuid, "viewer")
	}
	if c == nil {
		return nil, ErrPeerNotFound
	}
	c.mu.Lock()
	existing := c.channels[label]
	c.mu.Unlock()
	if existing != nil && existing.ReadyState() != webrtc.DataChannelStateClosed && existing.ReadyState() != webrtc.DataChannelStateClosing {
		return existing, waitChannelOpen(ctx, existing, o.Timeout)
	}
	init := &webrtc.DataChannelInit{Ordered: o.Ordered, MaxRetransmits: o.MaxRetransmits, MaxPacketLifeTime: o.MaxPacketLifeTime}
	if o.Protocol != "" {
		init.Protocol = &o.Protocol
	}
	dc, err := c.pc.CreateDataChannel(label, init)
	if err != nil {
		return nil, err
	}
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
	if err := waitChannelOpen(ctx, dc, o.Timeout); err != nil {
		return nil, err
	}
	return dc, nil
}

// SendBinary sends raw bytes to a peer on the dedicated "x-bin" channel,
// applying backpressure when the send buffer is above the high-water mark. It
// never uses the control channel (VDO.Ninja would render bytes there as an
// image).
func (s *SDK) SendBinary(ctx context.Context, uuid string, data []byte) error {
	dc, err := s.OpenChannel(ctx, uuid, BinaryChannelLabel)
	if err != nil {
		return err
	}
	if !waitBelow(dc, defaultBufferHigh, 30*time.Second) {
		return errors.New("vdoninja: binary channel did not drain")
	}
	return dc.Send(data)
}

func (s *SDK) setupBinaryChannel(c *Connection, dc *webrtc.DataChannel) {
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		b := make([]byte, len(m.Data))
		copy(b, m.Data)
		s.emit(Event{Type: EventBinaryReceived, UUID: c.uuid, StreamID: c.StreamID(), Bytes: b, Label: dc.Label()})
	})
}

func (s *SDK) setupReservedChannel(c *Connection, dc *webrtc.DataChannel) {
	dc.SetBufferedAmountLowThreshold(defaultBufferLow)
	dc.OnBufferedAmountLow(func() {
		s.emit(Event{Type: EventBufferedLow, UUID: c.uuid, StreamID: c.StreamID(), Label: dc.Label(), BufferedAmount: dc.BufferedAmount()})
	})
	s.emit(Event{Type: EventChannelOpen, UUID: c.uuid, StreamID: c.StreamID(), Label: dc.Label(), Channel: dc})
}

// BufferedAmount returns the bytes queued on a channel of a peer ("" for the
// control channel), or -1 when unknown.
func (s *SDK) BufferedAmount(uuid, label string) int64 {
	c := s.findConnection(uuid, "")
	if c == nil {
		return -1
	}
	if label == "" {
		label = ControlChannelLabel
	}
	c.mu.Lock()
	dc := c.channels[label]
	c.mu.Unlock()
	if dc == nil {
		return -1
	}
	return int64(dc.BufferedAmount())
}
