// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// FileEntry is an advertised file.
type FileEntry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// FileTransferInfo describes a transfer in file* events.
type FileTransferInfo struct {
	ID        string
	Name      string
	Size      int64
	Bytes     int64
	Direction string // "inbound" | "outbound"
	Requested bool
}

// FileResult is a completed download.
type FileResult struct {
	ID       string
	Name     string
	Size     int64
	UUID     string
	StreamID string
	Bytes    []byte
}

type hostedFile struct {
	id         string
	name       string
	size       int64
	open       func() (io.ReadCloser, error)
	restricted string
	cancelled  bool
}

type inboundTransfer struct {
	uuid     string
	id       string
	name     string
	size     int64
	received int64
	stream   bool
	buf      bytes.Buffer
	started  bool
	done     chan struct{}
	once     sync.Once
	result   *FileResult
	err      error
	streamID string
}

func (t *inboundTransfer) finish(r *FileResult, err error) {
	t.once.Do(func() {
		t.result = r
		t.err = err
		close(t.done)
	})
}

func parseFileEntries(list []any) []FileEntry {
	out := make([]FileEntry, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		e := FileEntry{Name: getString(m, "name")}
		switch id := m["id"].(type) {
		case string:
			e.ID = id
		case float64:
			e.ID = jsonNumberString(id)
		}
		if sz, ok := m["size"].(float64); ok {
			e.Size = int64(sz)
		}
		if e.ID != "" {
			out = append(out, e)
		}
	}
	return out
}

// HostFileOptions configures HostFile.
type HostFileOptions struct {
	// ID is the file ID (also the data channel label). Generated when empty.
	ID string
	// Restricted limits the offer to one peer UUID.
	Restricted string
}

// HostFile offers bytes to peers using VDO.Ninja's native file transfer. It is
// advertised immediately to viewers that opted in to downloads, and a VDO.Ninja
// browser peer shows it as a download in its chat.
func (s *SDK) HostFile(name string, data []byte, opts ...HostFileOptions) (FileEntry, error) {
	return s.HostReader(name, int64(len(data)), func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(data)), nil
	}, opts...)
}

// HostReader offers a file served from a reader factory (for large files).
func (s *SDK) HostReader(name string, size int64, open func() (io.ReadCloser, error), opts ...HostFileOptions) (FileEntry, error) {
	var o HostFileOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	if name == "" {
		return FileEntry{}, errors.New("vdoninja: file name required")
	}
	if strings.HasPrefix(o.ID, ReservedChannelPrefix) {
		return FileEntry{}, ErrReservedChannelLabel
	}
	s.mu.Lock()
	id := o.ID
	for id == "" || id == ControlChannelLabel || id == ChunkedChannelLabel || id == ResourcesChannelLabel ||
		strings.HasPrefix(id, ReservedChannelPrefix) || s.hostedFiles[id] != nil {
		id = generateStreamID()
	}
	f := &hostedFile{id: id, name: name, size: size, open: open, restricted: o.Restricted}
	s.hostedFiles[id] = f
	var targets []*Connection
	for uuid, pair := range s.connections {
		if pair.publisher != nil && (o.Restricted == "" || o.Restricted == uuid) {
			targets = append(targets, pair.publisher)
		}
	}
	s.mu.Unlock()
	entry := FileEntry{ID: id, Name: name, Size: size}
	for _, c := range targets {
		s.sendFileEntries(c, []FileEntry{entry})
	}
	return entry, nil
}

// UnhostFile stops offering a file and cancels transfers in flight. Peers that
// already saw the offer keep displaying it; requests are then refused.
func (s *SDK) UnhostFile(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.hostedFiles[id]
	if f == nil {
		return false
	}
	f.cancelled = true
	delete(s.hostedFiles, id)
	return true
}

// HostedFiles lists the files currently offered.
func (s *SDK) HostedFiles() []FileEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]FileEntry, 0, len(s.hostedFiles))
	for _, f := range s.hostedFiles {
		out = append(out, FileEntry{ID: f.id, Name: f.name, Size: f.size})
	}
	return out
}

func (s *SDK) fileListFor(uuid string) []FileEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []FileEntry
	for _, f := range s.hostedFiles {
		if f.restricted == "" || f.restricted == uuid {
			out = append(out, FileEntry{ID: f.id, Name: f.name, Size: f.size})
		}
	}
	return out
}

func (s *SDK) sendFileList(c *Connection) {
	s.sendFileEntries(c, s.fileListFor(c.uuid))
}

func (s *SDK) sendFileEntries(c *Connection, list []FileEntry) {
	c.mu.Lock()
	allowed := c.allowDownload
	var unsent []FileEntry
	for _, f := range list {
		if !c.advertised[f.ID] {
			unsent = append(unsent, f)
		}
	}
	c.mu.Unlock()
	if !allowed || len(unsent) == 0 {
		return
	}
	if c.sendControl(map[string]any{"fileList": unsent}) {
		c.mu.Lock()
		for _, f := range unsent {
			c.advertised[f.ID] = true
		}
		c.mu.Unlock()
	}
}

// handleFileRequest serves a hosted file to the requesting peer over a new
// data channel labelled with the file ID.
func (s *SDK) handleFileRequest(c *Connection, id string) {
	s.mu.Lock()
	f := s.hostedFiles[id]
	s.mu.Unlock()
	if f == nil || (f.restricted != "" && f.restricted != c.uuid) {
		s.logf("Refusing file request %q from %s", id, c.uuid)
		return
	}
	dc, err := c.pc.CreateDataChannel(id, nil)
	if err != nil {
		s.emit(Event{Type: EventFileError, UUID: c.uuid, Err: err, File: &FileTransferInfo{ID: id, Name: f.name, Size: f.size, Direction: "outbound"}})
		return
	}
	c.mu.Lock()
	c.channels[id] = dc
	c.mu.Unlock()
	dc.OnOpen(func() { go s.sendFile(c, dc, f) })
}

func (s *SDK) sendFile(c *Connection, dc *webrtc.DataChannel, f *hostedFile) {
	info := &FileTransferInfo{ID: f.id, Name: f.name, Size: f.size, Direction: "outbound", Requested: true}
	fail := func(err error) {
		s.emit(Event{Type: EventFileError, UUID: c.uuid, StreamID: c.StreamID(), Err: err, File: info})
		_ = dc.Close()
	}
	header, _ := json.Marshal(map[string]any{"type": "filetransfer", "size": f.size, "filename": f.name, "id": f.id})
	if err := dc.SendText(string(header)); err != nil {
		fail(err)
		return
	}
	s.emit(Event{Type: EventFileStart, UUID: c.uuid, StreamID: c.StreamID(), File: info})
	r, err := f.open()
	if err != nil {
		fail(err)
		return
	}
	defer r.Close()
	buf := make([]byte, FileChunkSize)
	var sent int64
	for {
		s.mu.Lock()
		cancelled := f.cancelled
		s.mu.Unlock()
		if cancelled {
			_ = dc.SendText(FileEOFCancelled)
			s.emit(Event{Type: EventFileCancelled, UUID: c.uuid, StreamID: c.StreamID(), File: info})
			waitDrain(dc, 5*time.Second)
			_ = dc.Close()
			return
		}
		n, rerr := io.ReadFull(r, buf)
		if n > 0 {
			if !waitBelow(dc, defaultBufferHigh, 30*time.Second) {
				fail(errors.New("send buffer did not drain"))
				return
			}
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			if err := dc.Send(chunk); err != nil {
				fail(err)
				return
			}
			sent += int64(n)
			info.Bytes = sent
			s.emit(Event{Type: EventFileProgress, UUID: c.uuid, StreamID: c.StreamID(), File: &FileTransferInfo{ID: f.id, Name: f.name, Size: f.size, Bytes: sent, Direction: "outbound"}})
		}
		if rerr != nil {
			if errors.Is(rerr, io.EOF) || errors.Is(rerr, io.ErrUnexpectedEOF) {
				break
			}
			fail(rerr)
			return
		}
	}
	if !waitDrain(dc, 30*time.Second) {
		fail(errors.New("send buffer did not drain before EOF"))
		return
	}
	if err := dc.SendText(FileEOFComplete); err != nil {
		fail(err)
		return
	}
	waitDrain(dc, 10*time.Second)
	s.emit(Event{Type: EventFileComplete, UUID: c.uuid, StreamID: c.StreamID(), File: &FileTransferInfo{ID: f.id, Name: f.name, Size: f.size, Bytes: sent, Direction: "outbound"}})
	// The receiver closes the channel after EOF1; give it a moment, then close ourselves.
	closed := make(chan struct{})
	dc.OnClose(func() { close(closed) })
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		_ = dc.Close()
	}
}

func waitDrain(dc *webrtc.DataChannel, timeout time.Duration) bool {
	return waitBelow(dc, 1, timeout)
}

func waitBelow(dc *webrtc.DataChannel, threshold uint64, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for dc.BufferedAmount() >= threshold {
		if dc.ReadyState() != webrtc.DataChannelStateOpen {
			return false
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(5 * time.Millisecond)
	}
	return dc.ReadyState() == webrtc.DataChannelStateOpen
}

// RequestFileOptions configures RequestFile.
type RequestFileOptions struct {
	// Stream delivers data through fileChunk events instead of buffering.
	Stream bool
	// Timeout bounds the wait for the transfer to start (default 30s).
	Timeout time.Duration
}

// RequestFile downloads a file a peer advertised in a fileList event.
func (s *SDK) RequestFile(ctx context.Context, uuid, fileID string, opts ...RequestFileOptions) (*FileResult, error) {
	var o RequestFileOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	if o.Timeout <= 0 {
		o.Timeout = 30 * time.Second
	}
	t := &inboundTransfer{uuid: uuid, id: fileID, stream: o.Stream, done: make(chan struct{})}
	key := uuid + ":" + fileID
	s.mu.Lock()
	s.inbound[key] = t
	s.mu.Unlock()
	// VDO.Ninja expects a bare {"requestFile": id} on the control channel (no pipe wrapper).
	if !s.sendRawControl(uuid, map[string]any{"requestFile": fileID}) {
		s.mu.Lock()
		delete(s.inbound, key)
		s.mu.Unlock()
		return nil, ErrNoDataChannel
	}
	startTimer := time.AfterFunc(o.Timeout, func() {
		s.mu.Lock()
		started := t.started
		if !started {
			delete(s.inbound, key)
		}
		s.mu.Unlock()
		if !started {
			t.finish(nil, fmt.Errorf("vdoninja: file transfer %s did not start", fileID))
		}
	})
	defer startTimer.Stop()
	select {
	case <-t.done:
		return t.result, t.err
	case <-ctx.Done():
		s.mu.Lock()
		delete(s.inbound, key)
		s.mu.Unlock()
		return nil, ctx.Err()
	}
}

// sendRawControl sends a bare JSON message (no pipe wrapper) on the control
// channel of a peer, publisher connection first.
func (s *SDK) sendRawControl(uuid string, msg map[string]any) bool {
	s.mu.Lock()
	pair := s.connections[uuid]
	var conns []*Connection
	if pair != nil {
		conns = []*Connection{pair.publisher, pair.viewer}
	}
	s.mu.Unlock()
	for _, c := range conns {
		if c != nil && c.sendControl(msg) {
			return true
		}
	}
	return false
}

func (s *SDK) setupFileReceiveChannel(c *Connection, dc *webrtc.DataChannel, label string) {
	var details map[string]any
	var t *inboundTransfer
	var id, name string
	var size int64
	finishErr := func(err error) {
		s.emit(Event{Type: EventFileError, UUID: c.uuid, StreamID: c.StreamID(), Err: err, File: &FileTransferInfo{ID: id, Name: name, Size: size, Direction: "inbound"}})
		if t != nil {
			s.mu.Lock()
			delete(s.inbound, c.uuid+":"+t.id)
			s.mu.Unlock()
			t.finish(nil, err)
		}
	}
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if details == nil {
			if !m.IsString {
				return
			}
			var parsed map[string]any
			if json.Unmarshal(m.Data, &parsed) != nil || parsed["type"] != "filetransfer" {
				return
			}
			details = parsed
			switch v := parsed["id"].(type) {
			case string:
				id = v
			case float64:
				id = jsonNumberString(v)
			}
			if id == "" {
				id = label
			}
			name = getString(parsed, "filename")
			if sz, ok := parsed["size"].(float64); ok {
				size = int64(sz)
			}
			s.mu.Lock()
			t = s.inbound[c.uuid+":"+id]
			if t == nil {
				t = s.inbound[c.uuid+":"+label]
			}
			if t != nil {
				t.started = true
				t.name, t.size, t.streamID = name, size, c.StreamID()
			}
			s.mu.Unlock()
			s.emit(Event{Type: EventFileStart, UUID: c.uuid, StreamID: c.StreamID(), File: &FileTransferInfo{ID: id, Name: name, Size: size, Direction: "inbound", Requested: t != nil}})
			return
		}
		if m.IsString {
			switch string(m.Data) {
			case FileEOFComplete:
				var received int64
				if t != nil {
					received = t.received
				}
				if t != nil && received != size {
					finishErr(fmt.Errorf("%w: received %d of %d bytes", ErrTransferSizeMismatch, received, size))
				} else {
					s.emit(Event{Type: EventFileComplete, UUID: c.uuid, StreamID: c.StreamID(), File: &FileTransferInfo{ID: id, Name: name, Size: size, Bytes: received, Direction: "inbound"}})
					if t != nil {
						s.mu.Lock()
						delete(s.inbound, c.uuid+":"+t.id)
						s.mu.Unlock()
						res := &FileResult{ID: id, Name: name, Size: size, UUID: c.uuid, StreamID: c.StreamID()}
						if !t.stream {
							res.Bytes = t.buf.Bytes()
						}
						t.finish(res, nil)
					}
				}
				_ = dc.Close()
			case FileEOFCancelled:
				s.emit(Event{Type: EventFileCancelled, UUID: c.uuid, StreamID: c.StreamID(), File: &FileTransferInfo{ID: id, Name: name, Size: size, Direction: "inbound"}})
				finishErr(ErrTransferCancelled)
				_ = dc.Close()
			}
			return
		}
		var received int64
		if t != nil {
			t.received += int64(len(m.Data))
			received = t.received
			if !t.stream {
				t.buf.Write(m.Data)
			}
		} else {
			received = int64(len(m.Data))
		}
		info := &FileTransferInfo{ID: id, Name: name, Size: size, Bytes: received, Direction: "inbound"}
		s.emit(Event{Type: EventFileProgress, UUID: c.uuid, StreamID: c.StreamID(), File: info})
		if t != nil && t.stream {
			chunk := make([]byte, len(m.Data))
			copy(chunk, m.Data)
			s.emit(Event{Type: EventFileChunk, UUID: c.uuid, StreamID: c.StreamID(), File: info, Bytes: chunk})
		}
	})
	dc.OnClose(func() {
		if t != nil {
			select {
			case <-t.done:
			default:
				finishErr(errors.New("vdoninja: file channel closed before completion"))
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Resources channel (VDO.Ninja template images)
// ---------------------------------------------------------------------------

// ResourceMetadata describes a resource; TemplateName is required.
type ResourceMetadata struct {
	TemplateName string `json:"templateName"`
	Type         string `json:"type,omitempty"`
	Size         int64  `json:"size"`
}

// SendResource sends bytes on VDO.Ninja's "resources" channel to a peer that
// advertised allowresources. The receiver stores it under meta[templateName].
func (s *SDK) SendResource(ctx context.Context, uuid string, meta ResourceMetadata, data []byte) error {
	if meta.TemplateName == "" {
		return errors.New("vdoninja: templateName required")
	}
	if meta.Type == "" {
		meta.Type = "image/png"
	}
	meta.Size = int64(len(data))
	c := s.findConnection(uuid, "publisher")
	if c == nil {
		c = s.findConnection(uuid, "")
	}
	if c == nil {
		return ErrPeerNotFound
	}
	c.mu.Lock()
	allowed := c.allowResource
	dc := c.channels[ResourcesChannelLabel]
	c.mu.Unlock()
	if !allowed {
		return ErrResourcesNotAdvertised
	}
	if dc == nil {
		ordered := true
		retrans := uint16(30)
		var err error
		dc, err = c.pc.CreateDataChannel(ResourcesChannelLabel, &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &retrans})
		if err != nil {
			return err
		}
		c.mu.Lock()
		c.channels[ResourcesChannelLabel] = dc
		c.mu.Unlock()
		if err := waitChannelOpen(ctx, dc, 15*time.Second); err != nil {
			return err
		}
	}
	header, _ := json.Marshal(meta)
	if err := dc.SendText(string(header)); err != nil {
		return err
	}
	for off := 0; off < len(data); off += resourceChunkSize {
		end := off + resourceChunkSize
		if end > len(data) {
			end = len(data)
		}
		if !waitBelow(dc, defaultBufferHigh, 30*time.Second) {
			return errors.New("vdoninja: resources channel did not drain")
		}
		if err := dc.Send(data[off:end]); err != nil {
			return err
		}
	}
	return nil
}

func (s *SDK) setupResourceChannel(c *Connection, dc *webrtc.DataChannel) {
	c.mu.Lock()
	advertised := c.viewOptions.AllowResources
	c.mu.Unlock()
	if !advertised {
		s.logf("Peer %s opened a resources channel we did not ask for; closing", c.uuid)
		_ = dc.Close()
		return
	}
	var meta *ResourceMetadata
	var buf bytes.Buffer
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString {
			var parsed ResourceMetadata
			if json.Unmarshal(m.Data, &parsed) == nil && parsed.TemplateName != "" {
				meta = &parsed
				buf.Reset()
			}
			return
		}
		if meta == nil {
			return
		}
		buf.Write(m.Data)
		if int64(buf.Len()) >= meta.Size {
			out := make([]byte, buf.Len())
			copy(out, buf.Bytes())
			s.emit(Event{Type: EventResourceReceived, UUID: c.uuid, StreamID: c.StreamID(), Data: *meta, Bytes: out})
			meta = nil
			buf.Reset()
		}
	})
}

func waitChannelOpen(ctx context.Context, dc *webrtc.DataChannel, timeout time.Duration) error {
	if dc.ReadyState() == webrtc.DataChannelStateOpen {
		return nil
	}
	opened := make(chan struct{})
	var once sync.Once
	dc.OnOpen(func() { once.Do(func() { close(opened) }) })
	if dc.ReadyState() == webrtc.DataChannelStateOpen {
		return nil
	}
	select {
	case <-opened:
		return nil
	case <-time.After(timeout):
		return errors.New("vdoninja: data channel open timeout")
	case <-ctx.Done():
		return ctx.Err()
	}
}
