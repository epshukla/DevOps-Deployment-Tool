package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestSummarize(t *testing.T) {
	samples := []sample{
		{ok: true, latency: 10 * time.Millisecond},
		{ok: true, latency: 20 * time.Millisecond},
		{ok: false, latency: 30 * time.Millisecond},
		{ok: true, latency: 40 * time.Millisecond},
	}
	r := summarize("u", samples)
	if r.Requests != 4 || r.OK != 3 || r.SuccessRate != 0.75 {
		t.Fatalf("unexpected counts: %+v", r)
	}
	if r.MaxMs != 40 {
		t.Fatalf("max = %v, want 40", r.MaxMs)
	}
}

func TestProbeCountsFailures(t *testing.T) {
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt64(&hits, 1)%2 == 0 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	r := probe(srv.Client(), srv.URL, 10, 3)
	if r.Requests != 10 || r.OK != 5 {
		t.Fatalf("got %+v, want 10 requests / 5 ok", r)
	}
	if hits != 10 {
		t.Fatalf("server saw %d requests, want 10", hits)
	}
}
