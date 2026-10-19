// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

// Command vdoninja-signal runs a local VDO.Ninja-compatible signaling server.
//
//	vdoninja-signal -addr :8443 -cert fullchain.pem -key privkey.pem
//
// Point SDKs at ws://host:port (or wss:// with TLS) and VDO.Ninja browser pages
// at &wss2=host:port. Intended for development, LAN and offline use.
package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/steveseguin/ninjasdk/go/signalserver"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	cert := flag.String("cert", "", "TLS certificate (PEM); enables wss://")
	key := flag.String("key", "", "TLS private key (PEM)")
	flag.Parse()

	srv := signalserver.New()
	log.Printf("vdoninja-signal listening on %s", *addr)
	if *cert != "" && *key != "" {
		log.Fatal(http.ListenAndServeTLS(*addr, *cert, *key, srv))
	}
	log.Fatal(http.ListenAndServe(*addr, srv))
}
