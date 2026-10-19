// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// record: view a VDO.Ninja stream and write its video to an IVF file (VP8/VP9)
// and audio to an OGG file (Opus). This is a headless server-side recorder.
//
//	go run ./examples/record -stream mycam -room myroom -out capture
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/ivfwriter"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"

	vdoninja "github.com/steveseguin/ninjasdk/go"
)

func main() {
	stream := flag.String("stream", "", "stream ID to record (required)")
	room := flag.String("room", "", "room (required when the publisher is in a room)")
	password := flag.String("password", "", "password (default: shared default)")
	host := flag.String("host", vdoninja.DefaultHost, "signaling server")
	out := flag.String("out", "recording", "output file prefix")
	debug := flag.Bool("debug", false, "verbose logging")
	flag.Parse()
	if *stream == "" {
		flag.Usage()
		os.Exit(2)
	}

	sdk := vdoninja.New(vdoninja.Options{Host: *host, Password: *password, Debug: *debug, Label: "Go recorder"})
	sdk.On(vdoninja.EventTrack, func(ev vdoninja.Event) {
		track := ev.Track
		codec := track.Codec().MimeType
		log.Printf("track %s (%s) from %s", track.Kind(), codec, ev.UUID)
		switch {
		case strings.EqualFold(codec, webrtc.MimeTypeVP8), strings.EqualFold(codec, webrtc.MimeTypeVP9):
			w, err := ivfwriter.New(*out+".ivf", ivfwriter.WithCodec(codec))
			if err != nil {
				log.Fatal(err)
			}
			// Ask for keyframes periodically so the recording starts cleanly.
			go func() {
				ticker := time.NewTicker(2 * time.Second)
				defer ticker.Stop()
				for range ticker.C {
					pc := sdk.Connection(ev.UUID, "viewer")
					if pc == nil {
						return
					}
					_ = pc.PeerConnection().WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())}})
				}
			}()
			go func() {
				defer w.Close()
				for {
					pkt, _, err := track.ReadRTP()
					if err != nil {
						return
					}
					if err := w.WriteRTP(pkt); err != nil {
						log.Printf("ivf write: %v", err)
					}
				}
			}()
		case strings.EqualFold(codec, webrtc.MimeTypeOpus):
			w, err := oggwriter.New(*out+".ogg", 48000, 2)
			if err != nil {
				log.Fatal(err)
			}
			go func() {
				defer w.Close()
				for {
					pkt, _, err := track.ReadRTP()
					if err != nil {
						return
					}
					if err := w.WriteRTP(pkt); err != nil {
						log.Printf("ogg write: %v", err)
					}
				}
			}()
		default:
			log.Printf("codec %s not written by this example (H264 needs a different container)", codec)
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := sdk.Connect(ctx); err != nil {
		log.Fatal(err)
	}
	if *room != "" {
		if err := sdk.JoinRoom(ctx, *room); err != nil {
			log.Fatal(err)
		}
	}
	if _, err := sdk.View(ctx, *stream); err != nil && err != vdoninja.ErrStreamNotYetAvailable {
		log.Fatal(err)
	}
	log.Printf("recording %s to %s.{ivf,ogg}; Ctrl-C to stop", *stream, *out)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	<-stop
	sdk.Disconnect()
}
