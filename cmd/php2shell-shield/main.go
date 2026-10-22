// Command php2shell-shield runs the PHP2Shell blocking proxy.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/imhyunho99/php2shell-shield/shield"
)

func main() {
	listen := flag.String("listen", ":8080", "address to listen on")
	upstream := flag.String("upstream", "", "PHP web server to protect, e.g. http://127.0.0.1:8081 (required)")
	maxBody := flag.Int64("max-body", 16<<20, "maximum request body in bytes")
	maxParts := flag.Int("max-parts", 1000, "maximum multipart parts per request")
	progress := flag.String("progress-fields", "PHP_SESSION_UPLOAD_PROGRESS", "comma-separated session.upload_progress.name values to block")
	cookies := flag.String("session-cookies", "PHPSESSID", "comma-separated session.name values to watch in responses")
	logOnly := flag.Bool("log-only", false, "report matches without blocking")
	certFile := flag.String("tls-cert", "", "TLS certificate file")
	keyFile := flag.String("tls-key", "", "TLS key file")
	flag.Parse()

	enc := json.NewEncoder(os.Stdout)
	h, err := shield.New(shield.Config{
		Upstream:       *upstream,
		MaxBodyBytes:   *maxBody,
		MaxParts:       *maxParts,
		ProgressFields: split(*progress),
		SessionCookies: split(*cookies),
		LogOnly:        *logOnly,
		OnEvent: func(e shield.Event) {
			enc.Encode(struct {
				Time string `json:"time"`
				shield.Event
			}{time.Now().UTC().Format(time.RFC3339), e})
		},
	})
	if err != nil {
		log.Fatal(err)
	}

	srv := &http.Server{
		Addr:              *listen,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
	}
	log.Printf("php2shell-shield %s -> %s (log-only=%v)", *listen, *upstream, *logOnly)
	if *certFile != "" {
		log.Fatal(srv.ListenAndServeTLS(*certFile, *keyFile))
	}
	log.Fatal(srv.ListenAndServe())
}

func split(s string) []string {
	var out []string
	for _, f := range strings.Split(s, ",") {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}
