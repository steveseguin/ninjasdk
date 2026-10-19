// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// interop: the Go peer of the cross-language interoperability test
// (spec/interop/run_interop.py). As a publisher it announces a data-only
// stream and echoes probes; as a viewer it connects, sends a probe, waits for
// the echo and performs one request/response round trip.
//
//	go run ./examples/interop -role publish -stream s1 -host ws://127.0.0.1:8080
//	go run ./examples/interop -role view -stream s1 -host ws://127.0.0.1:8080
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	vdoninja "github.com/steveseguin/ninjasdk/go"
)

func main() {
	role := flag.String("role", "view", "publish or view")
	stream := flag.String("stream", "interop", "stream ID")
	host := flag.String("host", vdoninja.DefaultHost, "signaling server")
	password := flag.String("password", "", "password (default: shared default)")
	debug := flag.Bool("debug", false, "verbose logging")
	flag.Parse()

	sdk := vdoninja.New(vdoninja.Options{Host: *host, Password: *password, Debug: *debug, Label: "go"})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := sdk.Connect(ctx); err != nil {
		fmt.Println("FAIL connect:", err)
		os.Exit(1)
	}
	if *role == "publish" {
		sdk.On(vdoninja.EventDataReceived, func(ev vdoninja.Event) {
			if m, ok := ev.Data.(map[string]any); ok {
				if probe, ok := m["probe"]; ok {
					sdk.SendDataTo(ev.UUID, map[string]any{"echo": probe, "lang": "go"})
				}
			}
		})
		sdk.OnRequest("whoami", func(data any, from string) (any, error) {
			return map[string]any{"lang": "go", "got": data}, nil
		})
		if _, err := sdk.Announce(ctx, vdoninja.PublishOptions{StreamID: *stream}); err != nil {
			fmt.Println("FAIL announce:", err)
			os.Exit(1)
		}
		fmt.Println("READY")
		select {} // until killed
	}

	echo := make(chan string, 1)
	sdk.On(vdoninja.EventDataReceived, func(ev vdoninja.Event) {
		if m, ok := ev.Data.(map[string]any); ok {
			if e, ok := m["echo"].(string); ok {
				lang, _ := m["lang"].(string)
				select {
				case echo <- e + " from " + lang:
				default:
				}
			}
		}
	})
	conn, err := sdk.View(ctx, *stream)
	if err != nil {
		fmt.Println("FAIL view:", err)
		os.Exit(1)
	}
	deadline := time.Now().Add(20 * time.Second)
	for conn.ControlChannel() == nil || conn.ControlChannel().ReadyState() != 2 {
		if time.Now().After(deadline) {
			fmt.Println("FAIL control channel never opened")
			os.Exit(1)
		}
		time.Sleep(50 * time.Millisecond)
	}
	probe := fmt.Sprintf("go-%d", time.Now().UnixNano()%100000)
	sdk.SendDataTo(conn.UUID(), map[string]any{"probe": probe})
	select {
	case got := <-echo:
		fmt.Println("OK echo", got)
	case <-time.After(15 * time.Second):
		fmt.Println("FAIL no echo")
		os.Exit(1)
	}
	res, err := sdk.Request(ctx, "whoami", map[string]any{"q": 1}, conn.UUID())
	if err != nil {
		fmt.Println("FAIL request:", err)
		os.Exit(1)
	}
	fmt.Println("OK rpc", res)
	sdk.Disconnect()
}
