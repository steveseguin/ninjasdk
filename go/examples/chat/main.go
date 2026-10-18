// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// chat: a terminal P2P chat over VDO.Ninja data channels. Run it twice (or
// alongside the JavaScript SDK's data-channel demo) with the same room.
//
//	go run ./examples/chat -room my_unique_room -name alice
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"time"

	vdoninja "github.com/steveseguin/ninjasdk/go"
)

func main() {
	room := flag.String("room", "", "room name (required)")
	name := flag.String("name", "", "display name / stream ID (generated when empty)")
	password := flag.String("password", "", "room password (default: shared default)")
	host := flag.String("host", vdoninja.DefaultHost, "signaling server")
	debug := flag.Bool("debug", false, "verbose SDK logging")
	flag.Parse()
	if *room == "" {
		flag.Usage()
		os.Exit(2)
	}

	sdk := vdoninja.New(vdoninja.Options{Host: *host, Password: *password, Debug: *debug, Label: *name})
	sdk.On(vdoninja.EventDataChannelOpen, func(ev vdoninja.Event) {
		fmt.Printf("* %s connected (%s)\n", ev.UUID[:8], ev.ConnectionType)
	})
	sdk.On(vdoninja.EventPeerDisconnected, func(ev vdoninja.Event) {
		fmt.Printf("* %s left\n", ev.UUID[:8])
	})
	sdk.On(vdoninja.EventDataReceived, func(ev vdoninja.Event) {
		if m, ok := ev.Data.(map[string]any); ok {
			if msg, ok := m["message"].(string); ok {
				from, _ := m["from"].(string)
				if from == "" {
					from = ev.UUID[:8]
				}
				fmt.Printf("<%s> %s\n", from, msg)
				return
			}
		}
		fmt.Printf("<%s> %v\n", ev.UUID[:8], ev.Data)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	ctl, err := sdk.AutoConnect(ctx, vdoninja.AutoConnectOptions{Room: *room, StreamID: *name, Label: *name})
	cancel()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Joined %q as %q. Type messages and press enter. Ctrl-C to quit.\n", *room, ctl.StreamID)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			if !sdk.SendData(map[string]any{"message": line, "from": ctl.StreamID}) {
				fmt.Println("(no peers connected yet)")
			}
		}
	}()
	<-stop
	ctl.Stop()
	sdk.Disconnect()
}
