// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
package vdoninja

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestFetchTURNScalarAndArrayURLs(t *testing.T) {
	for _, urls := range []string{`"turn:custom.test:3478"`, `["turn:custom.test:3478"]`} {
		t.Run(urls, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintf(w, `{"servers":[{"urls":%s,"username":"user","credential":"secret","tz":300,"udp":true}]}`, urls)
			}))
			defer srv.Close()
			servers, err := FetchTURNServers(context.Background(), srv.Client(), srv.URL)
			if err != nil {
				t.Fatal(err)
			}
			if len(servers) != 1 {
				t.Fatalf("unexpected fallback: %+v", servers)
			}
			selected := SelectTURNServers(servers, 300, false)
			if len(selected) != 1 || !reflect.DeepEqual(selected[0].URLs, []string{"turn:custom.test:3478"}) || selected[0].Username != "user" || selected[0].Credential != "secret" {
				t.Fatalf("custom TURN credentials lost: %+v", selected)
			}
		})
	}
}
