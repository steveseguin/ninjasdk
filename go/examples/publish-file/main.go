// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// publish-file: publish a VP8/VP9 IVF video file and/or an Opus OGG audio file
// as a VDO.Ninja stream that any VDO.Ninja viewer page can watch.
//
//	ffmpeg -i input.mp4 -c:v libvpx -b:v 2M -f ivf video.ivf
//	ffmpeg -i input.mp4 -c:a libopus -page_duration 20000 -vn audio.ogg
//	go run ./examples/publish-file -video video.ivf -audio audio.ogg -stream gofile -room myroom
//
// Then open: https://vdo.ninja/?view=gofile&room=myroom&scene
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
	"github.com/pion/webrtc/v4/pkg/media/oggreader"

	vdoninja "github.com/steveseguin/ninjasdk/go"
)

func main() {
	video := flag.String("video", "", "IVF file (VP8 or VP9)")
	audio := flag.String("audio", "", "OGG file (Opus)")
	stream := flag.String("stream", "", "stream ID (generated when empty)")
	room := flag.String("room", "", "optional room")
	password := flag.String("password", "", "password (default: shared default)")
	host := flag.String("host", vdoninja.DefaultHost, "signaling server")
	loop := flag.Bool("loop", true, "loop the files")
	debug := flag.Bool("debug", false, "verbose logging")
	flag.Parse()
	if *video == "" && *audio == "" {
		flag.Usage()
		os.Exit(2)
	}

	var tracks []webrtc.TrackLocal
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if *video != "" {
		f, err := os.Open(*video)
		if err != nil {
			log.Fatal(err)
		}
		ivf, header, err := ivfreader.NewWith(f)
		if err != nil {
			log.Fatal(err)
		}
		mime := webrtc.MimeTypeVP8
		if header.FourCC == "VP90" {
			mime = webrtc.MimeTypeVP9
		}
		track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: mime}, "video", "gofile")
		if err != nil {
			log.Fatal(err)
		}
		tracks = append(tracks, track)
		frameDur := time.Millisecond * time.Duration(float64(header.TimebaseNumerator)/float64(header.TimebaseDenominator)*1000)
		if frameDur <= 0 {
			frameDur = 33 * time.Millisecond
		}
		go func() {
			ticker := time.NewTicker(frameDur)
			defer ticker.Stop()
			for range ticker.C {
				frame, _, err := ivf.ParseNextFrame()
				if errors.Is(err, io.EOF) {
					if !*loop {
						cancel()
						return
					}
					_, _ = f.Seek(0, io.SeekStart)
					ivf, _, _ = ivfreader.NewWith(f)
					continue
				}
				if err != nil {
					log.Printf("ivf: %v", err)
					return
				}
				_ = track.WriteSample(media.Sample{Data: frame, Duration: frameDur})
			}
		}()
	}
	if *audio != "" {
		f, err := os.Open(*audio)
		if err != nil {
			log.Fatal(err)
		}
		ogg, _, err := oggreader.NewWith(f)
		if err != nil {
			log.Fatal(err)
		}
		track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "gofile")
		if err != nil {
			log.Fatal(err)
		}
		tracks = append(tracks, track)
		go func() {
			var lastGranule uint64
			ticker := time.NewTicker(20 * time.Millisecond)
			defer ticker.Stop()
			for range ticker.C {
				page, header, err := ogg.ParseNextPage()
				if errors.Is(err, io.EOF) {
					if !*loop {
						return
					}
					_, _ = f.Seek(0, io.SeekStart)
					ogg, _, _ = oggreader.NewWith(f)
					lastGranule = 0
					continue
				}
				if err != nil {
					log.Printf("ogg: %v", err)
					return
				}
				sampleCount := float64(header.GranulePosition - lastGranule)
				lastGranule = header.GranulePosition
				dur := time.Duration(sampleCount/48000*1000) * time.Millisecond
				_ = track.WriteSample(media.Sample{Data: page, Duration: dur})
			}
		}()
	}

	sdk := vdoninja.New(vdoninja.Options{Host: *host, Password: *password, Debug: *debug, Label: "Go file publisher"})
	sdk.On(vdoninja.EventPeerConnected, func(ev vdoninja.Event) { log.Printf("viewer connected: %s", ev.UUID) })
	sdk.On(vdoninja.EventPeerDisconnected, func(ev vdoninja.Event) { log.Printf("viewer left: %s", ev.UUID) })
	cctx, ccancel := context.WithTimeout(ctx, 30*time.Second)
	defer ccancel()
	if err := sdk.Connect(cctx); err != nil {
		log.Fatal(err)
	}
	sid, err := sdk.Publish(cctx, tracks, vdoninja.PublishOptions{StreamID: *stream, Room: *room})
	if err != nil {
		log.Fatal(err)
	}
	url := fmt.Sprintf("https://vdo.ninja/?view=%s", sid)
	if *room != "" {
		url += "&room=" + vdoninja.SanitizeRoom(*room) + "&scene"
	}
	if *password != "" {
		url += "&password=" + vdoninja.EncodeURIComponent(vdoninja.EncodeURIComponent(*password))
	}
	fmt.Println("Publishing. Watch at:", url)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	select {
	case <-stop:
	case <-ctx.Done():
	}
	sdk.Disconnect()
}
