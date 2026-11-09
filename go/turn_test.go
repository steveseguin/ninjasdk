// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
package vdoninja

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

// Expected values come from vdo.ninja/lib.js getTimezone(), not SDK selection code.
func TestBrowserTimezoneWinterAndSummer(t *testing.T) {
	for _, sample := range []struct {
		zone     string
		expected int
	}{
		{"America/Toronto", 300}, {"Europe/Berlin", -60},
		{"Australia/Sydney", -600}, {"Asia/Kolkata", -270},
	} {
		zone, err := time.LoadLocation(sample.zone)
		if err != nil {
			t.Fatal(err)
		}
		for _, month := range []time.Month{time.January, time.July} {
			got := browserTimezoneOffset(time.Date(2026, month, 15, 12, 0, 0, 0, zone))
			if got != sample.expected {
				t.Errorf("%s %v: got %d, want %d", sample.zone, month, got, sample.expected)
			}
		}
	}
}

func TestFetchTURNPreservesQuery(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("region") != "ca" || q.Get("key") != "a+b" || !q.Has("empty") || q.Get("ts") == "" {
			t.Errorf("query corrupted: %v", q)
		}
		fmt.Fprint(w, `{"servers":[{"urls":["turn:fixture.invalid:3478"],"udp":true}]}`)
	}))
	defer srv.Close()
	_, err := FetchTURNServers(context.Background(), srv.Client(), srv.URL+"?region=ca&key=a%2Bb&empty=")
	if err != nil {
		t.Fatal(err)
	}
}

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
