// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/pion/webrtc/v4"
)

// TURNServer is one entry of the hosted TURN list.
type TURNServer struct {
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
	URLs       []string `json:"urls"`
	TZ         int      `json:"tz"`
	UDP        bool     `json:"udp"`
	Locale     string   `json:"locale"`
	delta      int
}

// UnmarshalJSON accepts the scalar and array forms of the standard urls field.
func (s *TURNServer) UnmarshalJSON(data []byte) error {
	type entry TURNServer
	var decoded struct {
		entry
		URLs json.RawMessage `json:"urls"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	if len(decoded.URLs) > 0 {
		var single string
		if err := json.Unmarshal(decoded.URLs, &single); err == nil && string(decoded.URLs) != "null" {
			decoded.entry.URLs = []string{single}
		} else if err := json.Unmarshal(decoded.URLs, &decoded.entry.URLs); err != nil {
			return err
		}
	}
	*s = TURNServer(decoded.entry)
	return nil
}

// fallbackTURNServers mirrors the official browser's built-in list, used only when
// the hosted TURN endpoint cannot be reached.
var fallbackTURNServers = []TURNServer{
	{Username: "use5", Credential: "c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc", URLs: []string{"turn:turn-use5.vdo.ninja:3478"}, TZ: 300, UDP: true, Locale: "use5"},
	{Username: "use5", Credential: "c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc", URLs: []string{"turns:turn-use5.vdo.ninja:443"}, TZ: 300, UDP: false, Locale: "use5"},
	{Username: "de3", Credential: "NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc", URLs: []string{"turn:turn-de3.vdo.ninja:3478"}, TZ: -60, UDP: true, Locale: "de3"},
	{Username: "de3", Credential: "NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc", URLs: []string{"turns:turn-de3.vdo.ninja:443"}, TZ: -60, UDP: false, Locale: "de3"},
	{Username: "pl2", Credential: "vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=", URLs: []string{"turn:turn-pl2.vdo.ninja:3478"}, TZ: -60, UDP: true, Locale: "pl2"},
	{Username: "pl2", Credential: "vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=", URLs: []string{"turns:turn-pl2.vdo.ninja:443"}, TZ: -60, UDP: false, Locale: "pl2"},
	{Username: "vdoninja", Credential: "EastSideRepresentZ", URLs: []string{"turn:turn-use3.vdo.ninja:3478"}, TZ: 300, UDP: true, Locale: "use3"},
	{Username: "vdoninja", Credential: "EastSideRepresentZ", URLs: []string{"turns:turn-use3.vdo.ninja:443"}, TZ: 300, UDP: false, Locale: "use3"},
	{Username: "vdoninja", Credential: "ViennaSchnitzel", URLs: []string{"turn:turn-eu5.vdo.ninja:3478"}, TZ: -60, UDP: true, Locale: "eu5"},
	{Username: "vdoninja", Credential: "ViennaSchnitzel", URLs: []string{"turns:turn-eu5.vdo.ninja:443"}, TZ: -60, UDP: false, Locale: "eu5"},
	{Username: "vdoninja", Credential: "donotuseplease", URLs: []string{"turn:turn-usw3.vdo.ninja:3478"}, TZ: 480, UDP: true, Locale: "usw3"},
	{Username: "vdoninja", Credential: "donotuseplease", URLs: []string{"turns:turn-usw3.vdo.ninja:443"}, TZ: 480, UDP: false, Locale: "usw3"},
	{Username: "vdoninja", Credential: "donotuseplease", URLs: []string{"turn:turn-usw4.vdo.ninja:3478"}, TZ: 480, UDP: true, Locale: "usw4"},
	{Username: "vdoninja", Credential: "donotuseplease", URLs: []string{"turns:turn-usw4.vdo.ninja:443"}, TZ: 480, UDP: false, Locale: "usw4"},
	{Username: "vdoninja", Credential: "donotuseplease", URLs: []string{"turn:turn-usw5.vdo.ninja:3478"}, TZ: 480, UDP: true, Locale: "usw5"},
	{Username: "vdoninja", Credential: "donotuseplease", URLs: []string{"turns:turn-usw5.vdo.ninja:443"}, TZ: 480, UDP: false, Locale: "usw5"},
	{Username: "vdoninja", Credential: "donotuseplease", URLs: []string{"turn:turn-fr1.vdo.ninja:3478"}, TZ: -60, UDP: true, Locale: "fr1"},
	{Username: "vdoninja", Credential: "donotuseplease", URLs: []string{"turns:turn-fr1.vdo.ninja:443"}, TZ: -60, UDP: false, Locale: "fr1"},
	{Username: "vdoninja", Credential: "donotuseplease", URLs: []string{"turn:turn-fr2.vdo.ninja:3478"}, TZ: -60, UDP: true, Locale: "fr2"},
	{Username: "vdoninja", Credential: "donotuseplease", URLs: []string{"turns:turn-fr2.vdo.ninja:443"}, TZ: -60, UDP: false, Locale: "fr2"},
	{Username: "vdoninja", Credential: "IchBinSteveDerNinja", URLs: []string{"turn:www.turn.vdo.ninja:3478"}, TZ: -60, UDP: true, Locale: "de2"},
	{Username: "vdoninja", Credential: "IchBinSteveDerNinja", URLs: []string{"turns:www.turn.vdo.ninja:443"}, TZ: -60, UDP: false, Locale: "de2"},
	{Username: "vdoninja", Credential: "EastSideRepresentZ", URLs: []string{"turn:turn-use1.vdo.ninja:3478"}, TZ: 300, UDP: true, Locale: "use1"},
	{Username: "vdoninja", Credential: "EastSideRepresentZ", URLs: []string{"turns:turn-use1.vdo.ninja:443"}, TZ: 300, UDP: false, Locale: "use1"},
	{Username: "vdoninja", Credential: "pleaseUseYourOwn", URLs: []string{"turn:turn-use2.vdo.ninja:3478"}, TZ: 300, UDP: true, Locale: "use2"},
	{Username: "vdoninja", Credential: "pleaseUseYourOwn", URLs: []string{"turns:turn-use2.vdo.ninja:443"}, TZ: 300, UDP: false, Locale: "use2"},
}

// FetchTURNServers downloads the hosted TURN list. It falls back to a built-in
// list when the request fails, matching the JavaScript SDK.
func FetchTURNServers(ctx context.Context, client *http.Client, url string) ([]TURNServer, error) {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	if url == "" {
		url = DefaultTURNURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fallbackTURNServers, err
	}
	query := req.URL.Query()
	query.Set("ts", fmt.Sprintf("%d", time.Now().UnixMilli()))
	req.URL.RawQuery = query.Encode()
	resp, err := client.Do(req)
	if err != nil {
		return fallbackTURNServers, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fallbackTURNServers, fmt.Errorf("turn list http %d", resp.StatusCode)
	}
	var body struct {
		Servers []TURNServer `json:"servers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || len(body.Servers) == 0 {
		return fallbackTURNServers, fmt.Errorf("invalid turn list: %v", err)
	}
	return body.Servers, nil
}

// localTimezoneOffsetMinutes follows lib.js getTimezone (minutes west of UTC).
func localTimezoneOffsetMinutes() int {
	return browserTimezoneOffset(time.Now())
}

func browserTimezoneOffset(now time.Time) int {
	_, off := now.Zone()
	_, first := time.Date(1900, 2, 1, 0, 0, 0, 0, now.Location()).Zone()
	_, second := time.Date(1906, 2, 1, 0, 0, 0, 0, now.Location()).Zone()
	current, standard := -off/60, max(-first/60, -second/60)
	if current < standard {
		return current + 60
	}
	return current
}

// SelectTURNServers picks the closest servers by timezone: up to two UDP and one
// TCP/TLS server, matching the JavaScript SDK's _processTURNs.
func SelectTURNServers(list []TURNServer, tzOffsetMinutes int, forceTCP bool) []webrtc.ICEServer {
	servers := make([]TURNServer, len(list))
	copy(servers, list)
	for i := range servers {
		delta := servers[i].TZ - tzOffsetMinutes
		if delta < 0 {
			delta = -delta
		}
		if wrapped := abs(delta - 60*24); wrapped < delta {
			delta = wrapped
		}
		servers[i].delta = delta
	}
	sort.SliceStable(servers, func(i, j int) bool { return servers[i].delta < servers[j].delta })
	var out []webrtc.ICEServer
	udp, tcp := 0, 0
	for _, t := range servers {
		if forceTCP && t.UDP {
			continue
		}
		if t.UDP && udp < 2 {
			udp++
		} else if !t.UDP && tcp < 1 {
			tcp++
		} else {
			continue
		}
		out = append(out, webrtc.ICEServer{URLs: t.URLs, Username: t.Username, Credential: t.Credential})
	}
	return out
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// iceConfiguration builds the pion configuration, fetching TURN servers once
// per cache period.
func (s *SDK) iceConfiguration(ctx context.Context) webrtc.Configuration {
	var servers []webrtc.ICEServer
	for _, u := range s.opts.STUNServers {
		servers = append(servers, webrtc.ICEServer{URLs: []string{u}})
	}
	servers = append(servers, s.turnServers(ctx)...)
	cfg := webrtc.Configuration{ICEServers: servers}
	if s.opts.ForceTURN {
		cfg.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	return cfg
}

func (s *SDK) turnServers(ctx context.Context) []webrtc.ICEServer {
	switch s.opts.TURN {
	case TURNDisabled:
		return nil
	case TURNCustom:
		return s.opts.TURNServers
	}
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	if s.turnList != nil && time.Since(s.turnFetched) < s.opts.TURNCacheTTL {
		return s.turnList
	}
	fetchCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	list, err := FetchTURNServers(fetchCtx, s.opts.HTTPClient, s.opts.TURNURL)
	if err != nil {
		s.logf("TURN list fetch failed, using fallback: %v", err)
	}
	s.turnList = SelectTURNServers(list, localTimezoneOffsetMinutes(), s.opts.ForceTCPMode)
	s.turnFetched = time.Now()
	return s.turnList
}

// ClearTURNCache forces a fresh TURN list fetch on the next peer connection.
func (s *SDK) ClearTURNCache() {
	s.turnMu.Lock()
	s.turnList = nil
	s.turnMu.Unlock()
}
