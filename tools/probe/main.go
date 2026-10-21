// Command probe load-checks HTTP endpoints of a deployment: it sends N
// requests per URL with C concurrent workers and reports success rate and
// latency percentiles. Exit code 1 when any URL's success rate is below
// -min-success, so it can gate a DeployX pipeline step after a deploy:
//
//	probe -n 50 -c 10 -min-success 0.99 https://x.trycloudflare.com/health
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"
)

// Result summarizes the probes of one URL.
type Result struct {
	URL         string  `json:"url"`
	Requests    int     `json:"requests"`
	OK          int     `json:"ok"`
	SuccessRate float64 `json:"success_rate"`
	P50Ms       float64 `json:"p50_ms"`
	P95Ms       float64 `json:"p95_ms"`
	P99Ms       float64 `json:"p99_ms"`
	MaxMs       float64 `json:"max_ms"`
}

type sample struct {
	ok      bool
	latency time.Duration
}

// percentile returns the q-th percentile (0..1) of sorted durations, in ms.
func percentile(sorted []time.Duration, q float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(q*float64(len(sorted)-1) + 0.5)
	return float64(sorted[idx].Microseconds()) / 1000
}

// summarize turns raw samples into a Result.
func summarize(url string, samples []sample) Result {
	latencies := make([]time.Duration, 0, len(samples))
	ok := 0
	for _, s := range samples {
		if s.ok {
			ok++
		}
		latencies = append(latencies, s.latency)
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	r := Result{URL: url, Requests: len(samples), OK: ok}
	if len(samples) > 0 {
		r.SuccessRate = float64(ok) / float64(len(samples))
		r.P50Ms = percentile(latencies, 0.50)
		r.P95Ms = percentile(latencies, 0.95)
		r.P99Ms = percentile(latencies, 0.99)
		r.MaxMs = float64(latencies[len(latencies)-1].Microseconds()) / 1000
	}
	return r
}

// probe sends n GET requests to url using c workers; 2xx/3xx count as ok.
func probe(client *http.Client, url string, n, c int) Result {
	jobs := make(chan struct{})
	results := make(chan sample, n)
	var wg sync.WaitGroup
	for w := 0; w < c; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range jobs {
				start := time.Now()
				resp, err := client.Get(url)
				s := sample{latency: time.Since(start)}
				if err == nil {
					s.ok = resp.StatusCode < 400
					resp.Body.Close()
				}
				results <- s
			}
		}()
	}
	for i := 0; i < n; i++ {
		jobs <- struct{}{}
	}
	close(jobs)
	wg.Wait()
	close(results)

	samples := make([]sample, 0, n)
	for s := range results {
		samples = append(samples, s)
	}
	return summarize(url, samples)
}

func main() {
	n := flag.Int("n", 20, "requests per URL")
	c := flag.Int("c", 5, "concurrent workers")
	timeout := flag.Duration("timeout", 5*time.Second, "per-request timeout")
	minSuccess := flag.Float64("min-success", 0.95, "fail (exit 1) below this success rate")
	asJSON := flag.Bool("json", false, "print JSON instead of a table")
	flag.Parse()

	if flag.NArg() == 0 || *n < 1 || *c < 1 {
		fmt.Fprintln(os.Stderr, "usage: probe [-n 20] [-c 5] [-min-success 0.95] [-json] URL...")
		os.Exit(2)
	}

	client := &http.Client{Timeout: *timeout}
	failed := false
	var all []Result
	for _, url := range flag.Args() {
		r := probe(client, url, *n, *c)
		all = append(all, r)
		if r.SuccessRate < *minSuccess {
			failed = true
		}
	}

	if *asJSON {
		_ = json.NewEncoder(os.Stdout).Encode(all)
	} else {
		fmt.Printf("%-50s %8s %8s %8s %8s %8s\n", "URL", "OK", "p50ms", "p95ms", "p99ms", "maxms")
		for _, r := range all {
			fmt.Printf("%-50s %7.1f%% %8.1f %8.1f %8.1f %8.1f\n",
				r.URL, r.SuccessRate*100, r.P50Ms, r.P95Ms, r.P99Ms, r.MaxMs)
		}
	}
	if failed {
		os.Exit(1)
	}
}
