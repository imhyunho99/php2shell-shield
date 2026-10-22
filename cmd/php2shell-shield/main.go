// Command php2shell-shield runs the PHP2Shell blocking proxy.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/imhyunho99/php2shell-shield/shield"
)

var version = "dev" // set by -ldflags at release

func main() {
	listen := flag.String("listen", ":8080", "address to listen on")
	upstream := flag.String("upstream", "", "PHP web server to protect, e.g. http://127.0.0.1:8081 (required)")
	maxBody := flag.Int64("max-body", 16<<20, "maximum request body in bytes")
	maxParts := flag.Int("max-parts", 1000, "maximum multipart parts per request")
	maxPartHeaders := flag.Int("max-part-headers", 8, "maximum headers inside one multipart part")
	maxPartHeaderBytes := flag.Int("max-part-header-bytes", 4096, "maximum header bytes inside one multipart part")
	maxNesting := flag.Int("max-nesting", 8, "maximum [ ] nesting in multipart field names")
	blockMultipart := flag.Bool("block-multipart", false, "refuse every multipart request (for apps without uploads)")
	progress := flag.String("progress-fields", "PHP_SESSION_UPLOAD_PROGRESS", "comma-separated session.upload_progress.name values to block")
	cookies := flag.String("session-cookies", "PHPSESSID", "comma-separated session.name values to watch in responses")
	logOnly := flag.Bool("log-only", false, "report matches without blocking")
	certFile := flag.String("tls-cert", "", "TLS certificate file")
	keyFile := flag.String("tls-key", "", "TLS key file")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	var mu sync.Mutex // OnEvent runs on many request goroutines
	enc := json.NewEncoder(os.Stdout)
	h, err := shield.New(shield.Config{
		Upstream:           *upstream,
		MaxBodyBytes:       *maxBody,
		MaxParts:           *maxParts,
		MaxPartHeaders:     *maxPartHeaders,
		MaxPartHeaderBytes: *maxPartHeaderBytes,
		MaxNesting:         *maxNesting,
		BlockMultipart:     *blockMultipart,
		ProgressFields:     split(*progress),
		SessionCookies:     split(*cookies),
		LogOnly:            *logOnly,
		OnEvent: func(e shield.Event) {
			mu.Lock()
			defer mu.Unlock()
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	log.Printf("php2shell-shield %s %s -> %s (log-only=%v)", version, *listen, *upstream, *logOnly)
	if *certFile != "" {
		err = srv.ListenAndServeTLS(*certFile, *keyFile)
	} else {
		err = srv.ListenAndServe()
	}
	if !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
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
