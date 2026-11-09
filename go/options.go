// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"log"
	"net/http"
	"time"

	"github.com/pion/webrtc/v4"
)

// Default values shared with the JavaScript SDK and VDO.Ninja.
const (
	DefaultHost     = "wss://wss.vdo.ninja"
	DefaultPassword = "someEncryptionKey123"
	DefaultSalt     = "vdo.ninja"
	DefaultTURNURL  = "https://turnservers.vdo.ninja/"

	// ControlChannelLabel is the only data channel that carries the JSON control
	// protocol (SDP, ICE, ping/pong, publisher info, viewer preferences, pipe data).
	ControlChannelLabel = "sendChannel"
	// ChunkedChannelLabel and ResourcesChannelLabel are VDO.Ninja side channels.
	ChunkedChannelLabel   = "chunked"
	ResourcesChannelLabel = "resources"
	// ReservedChannelPrefix marks third-party SDK channels that VDO.Ninja ignores.
	ReservedChannelPrefix = "x-"
	// BinaryChannelLabel is the default lane used by SendBinary.
	BinaryChannelLabel = "x-bin"

	FileChunkSize      = 16384
	FileEOFComplete    = "EOF1"
	FileEOFCancelled   = "EOF2"
	resourceChunkSize  = 16384
	defaultBufferLow   = 262144
	defaultBufferHigh  = 1048576
	signalingQueueSize = 30
)

// DefaultSTUNServers are used when Options.STUNServers is nil.
var DefaultSTUNServers = []string{"stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"}

// TURNMode selects how TURN relay servers are obtained.
type TURNMode int

const (
	// TURNAuto fetches the hosted TURN list (with a built-in fallback list).
	TURNAuto TURNMode = iota
	// TURNDisabled uses STUN only. Cross-network connections may fail.
	TURNDisabled
	// TURNCustom uses Options.TURNServers verbatim.
	TURNCustom
)

// Options configures an SDK instance. The zero value is usable and connects to
// the hosted VDO.Ninja signaling service with the shared default password.
type Options struct {
	// Host is the signaling WebSocket URL. Default: wss://wss.vdo.ninja.
	Host string
	// Room to join by default when calling JoinRoom without a room.
	Room string
	// Password is the original (not URL-encoded) room/stream password. Empty
	// means the shared default "someEncryptionKey123".
	Password string
	// NoPassword disables password hashing and signaling encryption entirely
	// (the JavaScript SDK's password: false). WebRTC media/data stay encrypted.
	NoPassword bool
	// Salt affects stream ID hashing. Use "vdo.ninja" for interoperability with
	// https://vdo.ninja peers. Default: vdo.ninja.
	Salt string
	// Label is sent to viewers as publisher metadata when a control channel opens.
	Label string
	// Meta is optional publisher metadata; VDO.Ninja expects an object (map).
	Meta any
	// Order is an optional ordering hint string sent with publisher info.
	Order string
	// Info holds any additional publisher info flags (broadcast, allowdrawing,
	// iframe, widget, allowmidi, allowresources, allowchunked).
	Info map[string]any

	// TURN selects TURN handling. TURNServers is used when TURN == TURNCustom.
	TURN        TURNMode
	TURNServers []webrtc.ICEServer
	// ForceTURN requests relay-only ICE (privacy / firewall testing).
	ForceTURN bool
	// ForceTCPMode skips UDP TURN servers when selecting from the hosted list.
	ForceTCPMode bool
	// TURNURL overrides the hosted TURN list endpoint.
	TURNURL string
	// TURNCacheTTL controls how long a fetched TURN list is reused. Default 5m.
	TURNCacheTTL time.Duration
	// STUNServers are STUN URLs; nil uses DefaultSTUNServers, an empty slice disables STUN.
	STUNServers []string

	// MaxReconnectAttempts bounds automatic signaling reconnects (default 5).
	MaxReconnectAttempts int
	// ReconnectDelay is the initial reconnect backoff (default 1s, doubles, capped at 30s).
	ReconnectDelay time.Duration
	// ConnectionTimeout is how long a peer connection may take to connect before
	// recovery is attempted (default 20s).
	ConnectionTimeout time.Duration
	// DisconnectGracePeriod is how long a peer may stay in ICE "disconnected"
	// before recovery starts (default 5s).
	DisconnectGracePeriod time.Duration
	// ViewRetryInterval is how long a pending View waits before re-requesting a
	// stream that did not appear (default 15m; the room events also trigger it).
	ViewRetryInterval time.Duration
	// AutoPingViewer enables periodic viewer-side pings with ICE restart after
	// two missed replies. AutoPingInterval defaults to 10s.
	AutoPingViewer   bool
	AutoPingInterval time.Duration

	// API lets callers supply a pion API with a custom MediaEngine or
	// SettingEngine (codecs, port ranges, loopback candidates, ...).
	API *webrtc.API
	// HTTPClient is used for TURN discovery and WHIP/WHEP. Default: 5s timeout client.
	HTTPClient *http.Client

	// Debug enables verbose logging through Logger (or the standard logger).
	Debug  bool
	Logger *log.Logger
}

func (o *Options) withDefaults() Options {
	out := *o
	if out.Host == "" {
		out.Host = DefaultHost
	}
	if out.Salt == "" {
		out.Salt = DefaultSalt
	}
	if out.TURNURL == "" {
		out.TURNURL = DefaultTURNURL
	}
	if out.TURNCacheTTL <= 0 {
		out.TURNCacheTTL = 5 * time.Minute
	}
	if out.STUNServers == nil {
		out.STUNServers = append([]string(nil), DefaultSTUNServers...)
	}
	if out.MaxReconnectAttempts == 0 {
		out.MaxReconnectAttempts = 5
	}
	if out.ReconnectDelay <= 0 {
		out.ReconnectDelay = time.Second
	}
	if out.ConnectionTimeout <= 0 {
		out.ConnectionTimeout = 20 * time.Second
	}
	if out.DisconnectGracePeriod <= 0 {
		out.DisconnectGracePeriod = 5 * time.Second
	}
	if out.ViewRetryInterval <= 0 {
		out.ViewRetryInterval = 15 * time.Minute
	}
	if out.AutoPingInterval <= 0 {
		out.AutoPingInterval = 10 * time.Second
	}
	if out.HTTPClient == nil {
		out.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	if out.Logger == nil {
		out.Logger = log.Default()
	}
	return out
}

// PublishOptions configures Publish and Announce.
type PublishOptions struct {
	// StreamID to publish as; generated when empty.
	StreamID string
	// Room to join first if not already in a room.
	Room string
	// Password overrides the instance password for the room join (original text).
	Password string
	// Label, Meta, Order and Info override the instance-level publisher info.
	Label string
	Meta  any
	Order string
	Info  map[string]any
}

// ViewOptions configures View.
type ViewOptions struct {
	// Audio and Video request those tracks (default true). Set both false for a
	// data-only connection.
	Audio *bool
	Video *bool
	// Label is sent to the publisher as viewer info.
	Label string
	// Downloads advertises willingness to receive file offers (default true).
	Downloads *bool
	// AllowResources opts in to VDO.Ninja's "resources" channel.
	AllowResources bool
	// Timeout bounds how long View waits for the publisher's offer (default 15s).
	// When it elapses, View returns ErrStreamNotYetAvailable and the SDK keeps
	// the request pending so the stream connects automatically once it appears.
	Timeout time.Duration
}

// Bool is a helper for optional booleans in option structs.
func Bool(v bool) *bool { return &v }

func (v ViewOptions) audio() bool     { return v.Audio == nil || *v.Audio }
func (v ViewOptions) video() bool     { return v.Video == nil || *v.Video }
func (v ViewOptions) downloads() bool { return v.Downloads == nil || *v.Downloads }

// DataTarget selects where SendData routes a message.
type DataTarget struct {
	// UUID restricts delivery to one peer.
	UUID string
	// Type restricts delivery to "publisher" or "viewer" connections.
	Type string
	// StreamID restricts delivery to connections carrying that stream ID.
	StreamID string
	// Preference is "any" (publisher channel first, then viewer; default),
	// "publisher", "viewer" or "all" (both channels, may duplicate).
	Preference string
}
