// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// whip-publish: send an IVF (VP8) file to a WHIP endpoint such as Cloudflare
// Stream, MediaMTX or Meshcast.
//
//	go run ./examples/whip-publish -endpoint https://cae1.meshcast.io/whip/mystream -video video.ivf
package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log"
	"os"
	"os/signal"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/ivfreader"

	vdoninja "github.com/steveseguin/ninjasdk/go"
)

func main() {
	endpoint := flag.String("endpoint", "", "WHIP endpoint URL (required)")
	token := flag.String("token", "", "bearer token")
	video := flag.String("video", "", "IVF file (VP8)")
	flag.Parse()
	if *endpoint == "" || *video == "" {
		flag.Usage()
		os.Exit(2)
	}
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
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: mime}, "video", "whip")
	if err != nil {
		log.Fatal(err)
	}
	client := vdoninja.NewWHIPClient(*endpoint, vdoninja.WHIPOptions{AuthToken: *token})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	if err := client.Publish(ctx, []webrtc.TrackLocal{track}); err != nil {
		log.Fatal(err)
	}
	cancel()
	log.Println("publishing to", *endpoint)
	go func() {
		ticker := time.NewTicker(33 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			frame, _, err := ivf.ParseNextFrame()
			if errors.Is(err, io.EOF) {
				_, _ = f.Seek(0, io.SeekStart)
				ivf, _, _ = ivfreader.NewWith(f)
				continue
			}
			if err != nil {
				return
			}
			_ = track.WriteSample(media.Sample{Data: frame, Duration: 33 * time.Millisecond})
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	<-stop
	_ = client.Stop(context.Background())
}
