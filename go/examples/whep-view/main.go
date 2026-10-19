// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// whep-view: pull a stream from a WHEP endpoint and save VP8 video to an IVF file.
//
//	go run ./examples/whep-view -endpoint https://cae1.meshcast.io/whep/mystream -out whep
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/ivfwriter"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"

	vdoninja "github.com/steveseguin/ninjasdk/go"
)

func main() {
	endpoint := flag.String("endpoint", "", "WHEP endpoint URL (required)")
	token := flag.String("token", "", "bearer token")
	out := flag.String("out", "whep", "output file prefix")
	flag.Parse()
	if *endpoint == "" {
		flag.Usage()
		os.Exit(2)
	}
	client := vdoninja.NewWHEPClient(*endpoint, vdoninja.WHEPOptions{AuthToken: *token})
	client.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		codec := track.Codec().MimeType
		log.Printf("track %s %s", track.Kind(), codec)
		switch {
		case strings.EqualFold(codec, webrtc.MimeTypeVP8), strings.EqualFold(codec, webrtc.MimeTypeVP9):
			w, err := ivfwriter.New(*out+".ivf", ivfwriter.WithCodec(codec))
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
					_ = w.WriteRTP(pkt)
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
					_ = w.WriteRTP(pkt)
				}
			}()
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	if err := client.View(ctx); err != nil {
		log.Fatal(err)
	}
	cancel()
	log.Println("viewing", *endpoint)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	<-stop
	_ = client.Stop(context.Background())
}
