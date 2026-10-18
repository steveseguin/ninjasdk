// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"context"
	"net/http"
	"time"

	"github.com/pion/webrtc/v4"
)

// WHEPOptions configures a WHEPClient.
type WHEPOptions struct {
	AuthToken  string
	Headers    map[string]string
	ICEServers []webrtc.ICEServer
	API        *webrtc.API
	HTTPClient *http.Client
	// Audio and Video select which media to request (default both).
	Audio *bool
	Video *bool
	// GatherTimeout bounds ICE gathering before the offer is posted (default 3s).
	GatherTimeout time.Duration
}

// WHEPClient consumes media from a WHEP (WebRTC-HTTP egress) endpoint.
type WHEPClient struct {
	Endpoint string
	opts     WHEPOptions
	pc       *webrtc.PeerConnection
	resource string
	onTrack  func(*webrtc.TrackRemote, *webrtc.RTPReceiver)
}

// NewWHEPClient creates a client for an endpoint URL.
func NewWHEPClient(endpoint string, opts WHEPOptions) *WHEPClient {
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Timeout: 15 * time.Second}
	}
	if opts.API == nil {
		opts.API = webrtc.NewAPI()
	}
	if opts.ICEServers == nil {
		opts.ICEServers = []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}, {URLs: []string{"stun:stun.cloudflare.com:3478"}}}
	}
	if opts.GatherTimeout <= 0 {
		opts.GatherTimeout = 3 * time.Second
	}
	return &WHEPClient{Endpoint: endpoint, opts: opts}
}

// OnTrack registers the callback invoked for each incoming track. Call it before View.
func (w *WHEPClient) OnTrack(f func(*webrtc.TrackRemote, *webrtc.RTPReceiver)) { w.onTrack = f }

// PeerConnection returns the underlying peer connection after View.
func (w *WHEPClient) PeerConnection() *webrtc.PeerConnection { return w.pc }

// View negotiates with the endpoint and starts receiving.
func (w *WHEPClient) View(ctx context.Context) error {
	pc, err := w.opts.API.NewPeerConnection(webrtc.Configuration{ICEServers: w.opts.ICEServers})
	if err != nil {
		return err
	}
	w.pc = pc
	if w.onTrack != nil {
		pc.OnTrack(w.onTrack)
	}
	recv := webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}
	if w.opts.Audio == nil || *w.opts.Audio {
		if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, recv); err != nil {
			_ = pc.Close()
			return err
		}
	}
	if w.opts.Video == nil || *w.opts.Video {
		if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, recv); err != nil {
			_ = pc.Close()
			return err
		}
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		_ = pc.Close()
		return err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		_ = pc.Close()
		return err
	}
	select {
	case <-gathered:
	case <-time.After(w.opts.GatherTimeout):
	case <-ctx.Done():
		_ = pc.Close()
		return ctx.Err()
	}
	resource, _, resp, err := postSDP(ctx, w.opts.HTTPClient, w.Endpoint, w.opts.AuthToken, w.opts.Headers, pc.LocalDescription().SDP)
	if err != nil {
		_ = pc.Close()
		return err
	}
	w.resource = resource
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: resp.answer}); err != nil {
		_ = pc.Close()
		return err
	}
	return nil
}

// Stop deletes the WHEP resource and closes the peer connection.
func (w *WHEPClient) Stop(ctx context.Context) error {
	return stopResource(ctx, w.opts.HTTPClient, w.resource, w.opts.AuthToken, w.opts.Headers, w.pc)
}
