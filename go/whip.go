// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

// WHIPOptions configures a WHIPClient.
type WHIPOptions struct {
	AuthToken  string
	Headers    map[string]string
	ICEServers []webrtc.ICEServer
	API        *webrtc.API
	HTTPClient *http.Client
	// GatherTimeout bounds ICE gathering before the offer is posted (default 3s).
	GatherTimeout time.Duration
}

// WHIPClient publishes tracks to a WHIP (WebRTC-HTTP ingestion) endpoint such
// as Cloudflare Stream, Twitch, Meshcast or MediaMTX.
type WHIPClient struct {
	Endpoint string
	opts     WHIPOptions
	pc       *webrtc.PeerConnection
	resource string
	etag     string
}

// NewWHIPClient creates a client for an endpoint URL.
func NewWHIPClient(endpoint string, opts WHIPOptions) *WHIPClient {
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
	return &WHIPClient{Endpoint: endpoint, opts: opts}
}

// PeerConnection returns the underlying peer connection after Publish.
func (w *WHIPClient) PeerConnection() *webrtc.PeerConnection { return w.pc }

// Publish negotiates with the endpoint and starts sending the tracks.
func (w *WHIPClient) Publish(ctx context.Context, tracks []webrtc.TrackLocal) error {
	if len(tracks) == 0 {
		return errors.New("vdoninja: whip requires at least one track")
	}
	pc, err := w.opts.API.NewPeerConnection(webrtc.Configuration{ICEServers: w.opts.ICEServers})
	if err != nil {
		return err
	}
	w.pc = pc
	for _, t := range tracks {
		sender, err := pc.AddTrack(t)
		if err != nil {
			_ = pc.Close()
			return err
		}
		go func() {
			buf := make([]byte, 1500)
			for {
				if _, _, err := sender.Read(buf); err != nil {
					return
				}
			}
		}()
	}
	return w.negotiate(ctx, pc)
}

func (w *WHIPClient) negotiate(ctx context.Context, pc *webrtc.PeerConnection) error {
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}
	select {
	case <-gathered:
	case <-time.After(w.opts.GatherTimeout):
	case <-ctx.Done():
		return ctx.Err()
	}
	local := pc.LocalDescription()
	resource, etag, links, err := postSDP(ctx, w.opts.HTTPClient, w.Endpoint, w.opts.AuthToken, w.opts.Headers, local.SDP)
	if err != nil {
		_ = pc.Close()
		return err
	}
	_ = links
	w.resource, w.etag = resource, etag
	answer := webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: links.answer}
	if err := pc.SetRemoteDescription(answer); err != nil {
		_ = pc.Close()
		return err
	}
	return nil
}

// Stop deletes the WHIP resource and closes the peer connection.
func (w *WHIPClient) Stop(ctx context.Context) error {
	return stopResource(ctx, w.opts.HTTPClient, w.resource, w.opts.AuthToken, w.opts.Headers, w.pc)
}

type sdpResponse struct {
	answer     string
	iceServers []webrtc.ICEServer
}

var linkRe = regexp.MustCompile(`<([^>]+)>\s*;([^,]*)`)

// ParseICEServersFromLink parses WHIP/WHEP Link headers of the form
// <stun:host>; rel="ice-server"; username="u"; credential="c".
func ParseICEServersFromLink(header string) []webrtc.ICEServer {
	var out []webrtc.ICEServer
	for _, m := range linkRe.FindAllStringSubmatch(header, -1) {
		if !strings.Contains(m[2], "ice-server") {
			continue
		}
		srv := webrtc.ICEServer{URLs: []string{m[1]}}
		for _, part := range strings.Split(m[2], ";") {
			kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
			if len(kv) != 2 {
				continue
			}
			val := strings.Trim(kv[1], `"`)
			switch kv[0] {
			case "username":
				srv.Username = val
			case "credential":
				srv.Credential = val
			}
		}
		out = append(out, srv)
	}
	return out
}

func postSDP(ctx context.Context, client *http.Client, endpoint, token string, headers map[string]string, sdp string) (resource, etag string, resp sdpResponse, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewBufferString(sdp))
	if err != nil {
		return "", "", resp, err
	}
	req.Header.Set("Content-Type", "application/sdp")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := client.Do(req)
	if err != nil {
		return "", "", resp, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", "", resp, fmt.Errorf("vdoninja: endpoint returned %d: %s", res.StatusCode, truncate(string(body), 200))
	}
	resp.answer = string(body)
	resp.iceServers = ParseICEServersFromLink(res.Header.Get("Link"))
	resource = res.Header.Get("Location")
	if resource != "" {
		if base, err := url.Parse(endpoint); err == nil {
			if ref, err := url.Parse(resource); err == nil {
				resource = base.ResolveReference(ref).String()
			}
		}
	}
	etag = res.Header.Get("ETag")
	return resource, etag, resp, nil
}

func stopResource(ctx context.Context, client *http.Client, resource, token string, headers map[string]string, pc *webrtc.PeerConnection) error {
	var err error
	if resource != "" {
		req, rerr := http.NewRequestWithContext(ctx, http.MethodDelete, resource, nil)
		if rerr == nil {
			if token != "" {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			for k, v := range headers {
				req.Header.Set(k, v)
			}
			if res, derr := client.Do(req); derr != nil {
				err = derr
			} else {
				res.Body.Close()
			}
		}
	}
	if pc != nil {
		if cerr := pc.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}
	return err
}
