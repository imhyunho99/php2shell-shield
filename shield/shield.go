// Package shield is an HTTP reverse proxy that sits in front of a PHP web
// server and blocks the request and response shapes used by PHP2Shell
// (CVE-2026-109618, CVE-2026-109619).
//
// It is a stopgap. Upgrading PHP is the only complete fix.
package shield

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
)

const (
	RuleUploadProgress     = "upload-progress-field"
	RuleBodyTooLarge       = "body-too-large"
	RuleTooManyParts       = "too-many-parts"
	RuleMalformedMultipart = "malformed-multipart"
	RuleSessionCookieLeak  = "session-cookie-leak"
	RulePartHeaders        = "part-headers"
	RuleFieldNesting       = "field-nesting"
	RuleMultipartBlocked   = "multipart-blocked"
)

type Config struct {
	// Upstream is the PHP web server, e.g. http://127.0.0.1:8080.
	Upstream string
	// MaxBodyBytes caps request bodies. Large bodies are how attackers push
	// a worker into out-of-memory. Default 16 MiB.
	MaxBodyBytes int64
	// MaxParts caps multipart parts. Default 1000, PHP's max_input_vars default.
	MaxParts int
	// MaxPartHeaders and MaxPartHeaderBytes cap the headers inside each
	// multipart part. Many small part headers cost PHP far more memory than
	// they take on the wire. Defaults 8 and 4096.
	MaxPartHeaders     int
	MaxPartHeaderBytes int
	// MaxNesting caps '[' nesting in multipart field names. Default 8.
	MaxNesting int
	// BlockMultipart refuses all multipart bodies, for apps without uploads.
	BlockMultipart bool
	// ProgressFields are session.upload_progress.name values to block.
	// Default PHP_SESSION_UPLOAD_PROGRESS.
	ProgressFields []string
	// SessionCookies are session.name values to watch in responses.
	// Default PHPSESSID.
	SessionCookies []string
	// UpstreamConns is how many idle connections to keep open to the
	// upstream. Go's default of 2 makes a busy proxy open a connection per
	// request and run out of ports. Default 256.
	UpstreamConns int
	// LogOnly reports matches without blocking or stripping anything.
	LogOnly bool
	// OnEvent receives every match. May be nil.
	OnEvent func(Event)
}

type Event struct {
	Rule    string `json:"rule"`
	Remote  string `json:"remote"`
	Method  string `json:"method"`
	Path    string `json:"path"`
	Detail  string `json:"detail"`
	LogOnly bool   `json:"log_only"`
}

// PHP generates session IDs from [0-9a-zA-Z,-] and caps them at 256 chars.
// A leaked heap is URL-encoded, so it shows up as '%' and friends.
var validSessionID = regexp.MustCompile(`^[0-9A-Za-z,-]{0,256}$`)

type handler struct {
	cfg   Config
	proxy *httputil.ReverseProxy
}

func New(cfg Config) (http.Handler, error) {
	if cfg.Upstream == "" {
		return nil, errors.New("shield: upstream is required")
	}
	up, err := url.Parse(cfg.Upstream)
	if err != nil {
		return nil, fmt.Errorf("shield: bad upstream: %w", err)
	}
	if up.Scheme != "http" && up.Scheme != "https" {
		return nil, fmt.Errorf("shield: upstream must be http or https, got %q", cfg.Upstream)
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = 16 << 20
	}
	if cfg.MaxParts <= 0 {
		cfg.MaxParts = 1000
	}
	if cfg.MaxPartHeaders <= 0 {
		cfg.MaxPartHeaders = 8
	}
	if cfg.MaxPartHeaderBytes <= 0 {
		cfg.MaxPartHeaderBytes = 4096
	}
	if cfg.MaxNesting <= 0 {
		cfg.MaxNesting = 8
	}
	if cfg.UpstreamConns <= 0 {
		cfg.UpstreamConns = 256
	}
	if len(cfg.ProgressFields) == 0 {
		cfg.ProgressFields = []string{"PHP_SESSION_UPLOAD_PROGRESS"}
	}
	if len(cfg.SessionCookies) == 0 {
		cfg.SessionCookies = []string{"PHPSESSID"}
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = cfg.UpstreamConns
	transport.MaxIdleConnsPerHost = cfg.UpstreamConns

	h := &handler{cfg: cfg}
	h.proxy = &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(up)
			r.Out.Host = r.In.Host // PHP apps build URLs from Host
			r.SetXForwarded()
		},
		ModifyResponse: h.checkResponse,
	}
	return h, nil
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > h.cfg.MaxBodyBytes {
		h.deny(w, r, http.StatusRequestEntityTooLarge, RuleBodyTooLarge,
			fmt.Sprintf("content-length %d > %d", r.ContentLength, h.cfg.MaxBodyBytes))
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, h.cfg.MaxBodyBytes+1))
	r.Body.Close()
	if err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return
	}
	if int64(len(body)) > h.cfg.MaxBodyBytes {
		h.deny(w, r, http.StatusRequestEntityTooLarge, RuleBodyTooLarge,
			fmt.Sprintf("body > %d bytes", h.cfg.MaxBodyBytes))
		return
	}

	// The web server behind us may pick a different one than Go does.
	if len(r.Header.Values("Content-Type")) > 1 {
		if !h.deny(w, r, http.StatusBadRequest, RuleMalformedMultipart, "multiple content-type headers") {
			return
		}
	}

	if ct := r.Header.Get("Content-Type"); strings.Contains(strings.ToLower(ct), "multipart") {
		if status, rule, detail := h.inspectMultipart(ct, body); rule != "" {
			if !h.deny(w, r, status, rule, detail) {
				return
			}
		}
	}

	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	r.TransferEncoding = nil
	h.proxy.ServeHTTP(w, r)
}

// inspectMultipart returns a non-empty rule when the body must be refused.
// Anything that mentions multipart is checked, and anything we cannot parse
// is refused: if Go and PHP disagree on framing, we fail closed.
func (h *handler) inspectMultipart(ct string, body []byte) (int, string, string) {
	if h.cfg.BlockMultipart {
		return http.StatusUnsupportedMediaType, RuleMultipartBlocked, "multipart disabled"
	}

	// Byte search first, so a parser differential cannot hide the field.
	lower := bytes.ToLower(body)
	for _, f := range h.cfg.ProgressFields {
		if bytes.Contains(lower, []byte(strings.ToLower(f))) {
			return http.StatusForbidden, RuleUploadProgress, "field " + f
		}
	}

	mediaType, params, err := mime.ParseMediaType(ct)
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") || params["boundary"] == "" {
		return http.StatusBadRequest, RuleMalformedMultipart, "unparseable content-type " + ct
	}
	mr := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	parts := 0
	for {
		p, err := mr.NextRawPart()
		if err == io.EOF {
			return 0, "", ""
		}
		if err != nil {
			return http.StatusBadRequest, RuleMalformedMultipart, err.Error()
		}
		parts++
		if parts > h.cfg.MaxParts {
			return http.StatusRequestEntityTooLarge, RuleTooManyParts,
				fmt.Sprintf("more than %d parts", h.cfg.MaxParts)
		}
		n, size := 0, 0
		for k, vs := range p.Header {
			for _, v := range vs {
				n++
				size += len(k) + len(v)
			}
		}
		if n > h.cfg.MaxPartHeaders || size > h.cfg.MaxPartHeaderBytes {
			return http.StatusRequestHeaderFieldsTooLarge, RulePartHeaders,
				fmt.Sprintf("part %d has %d headers, %d bytes", parts, n, size)
		}
		if depth := strings.Count(p.FormName(), "["); depth > h.cfg.MaxNesting {
			return http.StatusBadRequest, RuleFieldNesting,
				fmt.Sprintf("field nested %d deep", depth)
		}
		if _, err := io.Copy(io.Discard, p); err != nil {
			return http.StatusBadRequest, RuleMalformedMultipart, err.Error()
		}
	}
}

// deny reports an event and, unless in log-only mode, writes the refusal.
// It returns true when the request should continue to the upstream.
func (h *handler) deny(w http.ResponseWriter, r *http.Request, status int, rule, detail string) bool {
	h.emit(r, rule, detail)
	if h.cfg.LogOnly {
		return true
	}
	http.Error(w, http.StatusText(status), status)
	return false
}

func (h *handler) emit(r *http.Request, rule, detail string) {
	if h.cfg.OnEvent == nil {
		return
	}
	remote := r.RemoteAddr
	if remote == "" {
		// Response-side events see the outbound request; recover the client
		// from the X-Forwarded-For header we set on it.
		remote = r.Header.Get("X-Forwarded-For")
	}
	h.cfg.OnEvent(Event{
		Rule:    rule,
		Remote:  remote,
		Method:  r.Method,
		Path:    r.URL.Path,
		Detail:  detail,
		LogOnly: h.cfg.LogOnly,
	})
}

// checkResponse drops session cookies whose value is not a valid PHP session
// ID. That is the channel PHP2Shell uses to send worker heap to the attacker.
func (h *handler) checkResponse(resp *http.Response) error {
	cookies := resp.Header.Values("Set-Cookie")
	if len(cookies) == 0 {
		return nil
	}
	kept := cookies[:0:0]
	for _, c := range cookies {
		name, value, _ := strings.Cut(strings.SplitN(c, ";", 2)[0], "=")
		name = strings.TrimSpace(name)
		if h.isSessionCookie(name) && !validSessionID.MatchString(strings.TrimSpace(value)) {
			h.emit(resp.Request, RuleSessionCookieLeak,
				fmt.Sprintf("%s cookie with %d-byte invalid value; restart PHP workers", name, len(value)))
			if !h.cfg.LogOnly {
				continue
			}
		}
		kept = append(kept, c)
	}
	resp.Header.Del("Set-Cookie")
	for _, c := range kept {
		resp.Header.Add("Set-Cookie", c)
	}
	return nil
}

func (h *handler) isSessionCookie(name string) bool {
	for _, s := range h.cfg.SessionCookies {
		if strings.EqualFold(name, s) {
			return true
		}
	}
	return false
}
