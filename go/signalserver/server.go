// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

// Package signalserver is a small VDO.Ninja-compatible signaling (handshake)
// server speaking the routed "wss2" protocol: server-assigned peer UUIDs,
// stream lookup, waiting viewers, room listings and director claims.
//
// It exists so the native SDKs can be tested offline and so that a single
// static binary can provide local signaling for LAN or air-gapped setups. It is
// not a replacement for the hosted service and does not implement rate
// limiting or TURN. For production self-hosting see
// https://github.com/steveseguin/websocket_server and
// https://github.com/steveseguin/offline_deployment.
package signalserver

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

type client struct {
	uuid string
	conn *websocket.Conn
	wmu  sync.Mutex
}

func (c *client) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	c.sendRaw(b)
}

func (c *client) sendRaw(b []byte) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.conn.WriteMessage(websocket.TextMessage, b)
}

// Server routes signaling messages between connected peers.
type Server struct {
	mu        sync.Mutex
	clients   map[string]*client
	streams   map[string]string          // streamID -> uuid
	streamIDs map[string]string          // uuid -> streamID
	rooms     map[string]string          // uuid -> roomid
	roomList  map[string][]string        // roomid -> uuids
	directors map[string]string          // roomid -> uuid
	waiting   map[string]map[string]bool // streamID -> set of viewer uuids
	upgrader  websocket.Upgrader
	// NewUUID generates peer IDs; defaults to a random UUID v4.
	NewUUID func() string
}

// New creates a server.
func New() *Server {
	return &Server{
		clients:   map[string]*client{},
		streams:   map[string]string{},
		streamIDs: map[string]string{},
		rooms:     map[string]string{},
		roomList:  map[string][]string{},
		directors: map[string]string{},
		waiting:   map[string]map[string]bool{},
		upgrader:  websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
		NewUUID:   randomUUID,
	}
}

// ServeHTTP upgrades the request to a WebSocket and serves it.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("VDO.Ninja signaling server (Go)\n"))
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &client{uuid: s.NewUUID(), conn: conn}
	s.mu.Lock()
	s.clients[c.uuid] = c
	s.mu.Unlock()
	defer s.cleanup(c.uuid)
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil || msg == nil {
			continue
		}
		s.handle(c, msg)
	}
}

func (s *Server) cleanup(uuid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.clients[uuid]
	if !ok {
		return
	}
	_ = c.conn.Close()
	delete(s.clients, uuid)
	if sid, ok := s.streamIDs[uuid]; ok {
		delete(s.streamIDs, uuid)
		if s.streams[sid] == uuid {
			delete(s.streams, sid)
		}
	}
	if room, ok := s.rooms[uuid]; ok {
		delete(s.rooms, uuid)
		if s.directors[room] == uuid {
			delete(s.directors, room)
		}
		s.roomList[room] = remove(s.roomList[room], uuid)
		if len(s.roomList[room]) == 0 {
			delete(s.roomList, room)
		}
	}
	for sid, set := range s.waiting {
		delete(set, uuid)
		if len(set) == 0 {
			delete(s.waiting, sid)
		}
	}
}

func remove(list []string, v string) []string {
	out := list[:0]
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func (s *Server) handle(c *client, msg map[string]any) {
	request := str(msg["request"])
	if request == "" {
		if _, ok := msg["leave"]; ok {
			s.leaveRoom(c)
			return
		}
		// Direct routing: UUID names the target; rewrite it to the sender.
		target := str(msg["UUID"])
		if target == "" {
			return
		}
		s.mu.Lock()
		t := s.clients[target]
		s.mu.Unlock()
		if t == nil {
			return
		}
		msg["UUID"] = c.uuid
		delete(msg, "from")
		t.send(msg)
		return
	}
	switch request {
	case "play":
		s.play(c, str(msg["streamID"]))
	case "seed":
		s.seed(c, str(msg["streamID"]))
	case "joinroom":
		claim, _ := msg["claim"].(bool)
		s.joinRoom(c, strings.ToLower(str(msg["roomid"])), claim, str(msg["streamID"]))
	case "migrate":
		s.migrate(c, str(msg["target"]), strings.ToLower(str(msg["roomid"])))
	}
}

func (s *Server) play(c *client, streamID string) {
	if streamID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	seederUUID, ok := s.streams[streamID]
	if !ok || seederUUID == c.uuid {
		if !ok {
			s.queue(c.uuid, streamID)
		}
		return
	}
	seeder := s.clients[seederUUID]
	if seeder == nil {
		s.queue(c.uuid, streamID)
		return
	}
	if room, inRoom := s.rooms[seederUUID]; inRoom && s.rooms[c.uuid] != room {
		s.queue(c.uuid, streamID)
		return
	}
	seeder.send(map[string]any{"request": "offerSDP", "UUID": c.uuid})
}

func (s *Server) queue(uuid, streamID string) {
	if s.waiting[streamID] == nil {
		s.waiting[streamID] = map[string]bool{}
	}
	s.waiting[streamID][uuid] = true
}

func (s *Server) seed(c *client, streamID string) {
	if streamID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.streamIDs[c.uuid]; ok && existing != streamID {
		c.send(map[string]any{"request": "alert", "message": "Stream ID cannot change on an existing connection."})
		return
	}
	if owner, ok := s.streams[streamID]; ok && owner != c.uuid {
		if _, alive := s.clients[owner]; alive {
			c.send(map[string]any{"request": "alert", "message": "Stream ID is already in use."})
			return
		}
	}
	s.streams[streamID] = c.uuid
	s.streamIDs[c.uuid] = streamID
	if room, ok := s.rooms[c.uuid]; ok {
		s.notifyRoom(room, map[string]any{"request": "videoaddedtoroom", "UUID": c.uuid, "streamID": streamID}, c.uuid)
	}
	if watchers := s.waiting[streamID]; len(watchers) > 0 {
		for viewer := range watchers {
			if _, alive := s.clients[viewer]; !alive {
				delete(watchers, viewer)
			} else if room := s.rooms[c.uuid]; room == "" || s.rooms[viewer] == room {
				c.send(map[string]any{"request": "offerSDP", "UUID": viewer})
				delete(watchers, viewer)
			}
		}
		if len(watchers) == 0 {
			delete(s.waiting, streamID)
		}
	}
}

// leaveRoom drops the client's room membership ({"leave": true}).
func (s *Server) leaveRoom(c *client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room, ok := s.rooms[c.uuid]
	if !ok {
		return
	}
	delete(s.rooms, c.uuid)
	if s.directors[room] == c.uuid {
		delete(s.directors, room)
	}
	members := s.roomList[room][:0:0]
	for _, m := range s.roomList[room] {
		if m != c.uuid {
			members = append(members, m)
		}
	}
	if len(members) == 0 {
		delete(s.roomList, room)
	} else {
		s.roomList[room] = members
	}
}

func (s *Server) joinRoom(c *client, room string, claim bool, streamID string) {
	if room == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, already := s.rooms[c.uuid]; already {
		return
	}
	if streamID != "" && s.streamIDs[c.uuid] == "" {
		// Same live-owner check as seed: joinroom must not take over a stream ID.
		if owner, ok := s.streams[streamID]; ok && owner != c.uuid {
			if _, alive := s.clients[owner]; alive {
				c.send(map[string]any{"request": "alert", "message": "Stream ID is already in use."})
				return
			}
		}
		s.streams[streamID] = c.uuid
		s.streamIDs[c.uuid] = streamID
	}
	s.rooms[c.uuid] = room
	resp := map[string]any{"request": "listing"}
	isDirector := false
	if claim {
		cur, has := s.directors[room]
		if _, alive := s.clients[cur]; !has || !alive {
			s.directors[room] = c.uuid
			resp["claim"] = true
			isDirector = true
		} else {
			resp["claim"] = cur == c.uuid
			if cur != c.uuid {
				resp["director"] = cur
			}
		}
	} else if d, ok := s.directors[room]; ok {
		resp["director"] = d
	}
	list := make([]map[string]any, 0, len(s.roomList[room]))
	for _, member := range s.roomList[room] {
		entry := map[string]any{"UUID": member}
		if sid, ok := s.streamIDs[member]; ok {
			entry["streamID"] = sid
		}
		if s.directors[room] == member {
			entry["director"] = true
		}
		list = append(list, entry)
	}
	resp["list"] = list
	c.send(resp)
	notice := map[string]any{"request": "someonejoined", "UUID": c.uuid}
	if isDirector {
		notice["director"] = true
	}
	if sid, ok := s.streamIDs[c.uuid]; ok {
		notice["streamID"] = sid
	}
	s.notifyRoom(room, notice, c.uuid)
	s.roomList[room] = append(s.roomList[room], c.uuid)
	// Viewers already waiting for streams that joined this room get their offers now.
	if sid, ok := s.streamIDs[c.uuid]; ok {
		if watchers := s.waiting[sid]; len(watchers) > 0 {
			for viewer := range watchers {
				if s.rooms[viewer] == room {
					delete(watchers, viewer)
					c.send(map[string]any{"request": "offerSDP", "UUID": viewer})
				}
			}
		}
	}
}

func (s *Server) migrate(c *client, target, destination string) {
	if target == "" || destination == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	directorRoom, ok := s.rooms[c.uuid]
	if !ok || s.directors[directorRoom] != c.uuid {
		return
	}
	sourceRoom, ok := s.rooms[target]
	if !ok || sourceRoom != directorRoom || target == c.uuid {
		return
	}
	s.roomList[sourceRoom] = remove(s.roomList[sourceRoom], target)
	if len(s.roomList[sourceRoom]) == 0 {
		delete(s.roomList, sourceRoom)
	}
	s.rooms[target] = destination
	view := map[string]any{"request": "transferred"}
	if d, ok := s.directors[destination]; ok {
		view["director"] = d
	}
	list := make([]map[string]any, 0)
	for _, member := range s.roomList[destination] {
		entry := map[string]any{"UUID": member}
		if sid, ok := s.streamIDs[member]; ok {
			entry["streamID"] = sid
		}
		list = append(list, entry)
	}
	view["list"] = list
	if t := s.clients[target]; t != nil {
		t.send(view)
	}
	notice := map[string]any{"request": "someonejoined", "UUID": target}
	if sid, ok := s.streamIDs[target]; ok {
		notice["streamID"] = sid
	}
	s.notifyRoom(destination, notice, target)
	s.roomList[destination] = append(s.roomList[destination], target)
}

// notifyRoom must be called with s.mu held.
func (s *Server) notifyRoom(room string, payload map[string]any, skip string) {
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	for _, member := range s.roomList[room] {
		if member == skip {
			continue
		}
		if cl := s.clients[member]; cl != nil {
			cl.sendRaw(b)
		}
	}
}
