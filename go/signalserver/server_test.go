// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
package signalserver

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestJoinRoomCannotStealStream(t *testing.T) {
	s := New()
	srv := httptest.NewServer(s)
	defer srv.Close()
	connect := func() *websocket.Conn {
		c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		return c
	}
	send := func(c *websocket.Conn, m map[string]any) {
		if err := c.WriteJSON(m); err != nil {
			t.Fatal(err)
		}
	}
	read := func(c *websocket.Conn) map[string]any {
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		var m map[string]any
		if err := c.ReadJSON(&m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	owner, other := connect(), connect()
	send(owner, map[string]any{"request": "seed", "streamID": "taken"})
	send(owner, map[string]any{"request": "joinroom", "roomid": "room"})
	if read(owner)["request"] != "listing" {
		t.Fatal("owner did not join")
	}
	send(other, map[string]any{"request": "seed", "streamID": "taken"})
	send(other, map[string]any{"request": "joinroom", "roomid": "room", "streamID": "taken", "claim": true})
	for i := 0; i < 2; i++ {
		if read(other)["request"] != "alert" {
			t.Fatal("duplicate registration accepted")
		}
	}
	s.mu.Lock()
	if len(s.streamIDs) != 1 || len(s.rooms) != 1 || len(s.directors) != 0 {
		t.Error("rejected join mutated registration or room state")
	}
	s.mu.Unlock()
	// A rejected client can still join as a viewer; plays must reach the owner.
	send(other, map[string]any{"request": "joinroom", "roomid": "room"})
	if read(other)["request"] != "listing" {
		t.Fatal("viewer could not join")
	}
	if read(owner)["request"] != "someonejoined" {
		t.Fatal("missing join notice")
	}
	send(other, map[string]any{"request": "play", "streamID": "taken"})
	if read(owner)["request"] != "offerSDP" {
		t.Fatal("stream routed away from owner")
	}
}
