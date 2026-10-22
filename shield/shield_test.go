package shield

import (
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// upstream echoes the body length and sets a session cookie chosen by the
// test through the X-Test-Cookie request header.
func upstream(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if c := r.Header.Get("X-Test-Cookie"); c != "" {
			w.Header().Add("Set-Cookie", c)
		}
		w.Header().Add("Set-Cookie", "theme=dark; Path=/")
		fmt.Fprintf(w, "got %d bytes", len(b))
	}))
}

func newShield(t *testing.T, cfg Config) (*httptest.Server, *[]Event) {
	t.Helper()
	up := upstream(t)
	t.Cleanup(up.Close)
	var events []Event
	cfg.Upstream = up.URL
	cfg.OnEvent = func(e Event) { events = append(events, e) }
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	return s, &events
}

func multipartBody(t *testing.T, fields [][2]string, files int) (string, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, f := range fields {
		mw.WriteField(f[0], f[1])
	}
	for i := 0; i < files; i++ {
		fw, _ := mw.CreateFormFile(fmt.Sprintf("f%d", i), "a.txt")
		fw.Write([]byte("hello"))
	}
	mw.Close()
	return mw.FormDataContentType(), buf.Bytes()
}

func post(t *testing.T, url, ct string, body []byte, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", ct)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestNormalMultipartPassesThrough(t *testing.T) {
	s, events := newShield(t, Config{})
	ct, body := multipartBody(t, [][2]string{{"title", "hi"}}, 2)
	resp := post(t, s.URL, ct, body, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	got, _ := io.ReadAll(resp.Body)
	if want := fmt.Sprintf("got %d bytes", len(body)); string(got) != want {
		t.Fatalf("upstream saw %q, want %q", got, want)
	}
	if len(*events) != 0 {
		t.Fatalf("unexpected events: %+v", *events)
	}
}

func TestUploadProgressFieldBlocked(t *testing.T) {
	s, events := newShield(t, Config{})
	ct, body := multipartBody(t, [][2]string{{"PHP_SESSION_UPLOAD_PROGRESS", "x"}}, 1)
	resp := post(t, s.URL, ct, body, nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
	if len(*events) != 1 || (*events)[0].Rule != RuleUploadProgress {
		t.Fatalf("events = %+v", *events)
	}
}

// The raw-byte check must catch the field even when the multipart framing is
// something Go's parser and PHP's parser might disagree on.
func TestUploadProgressFieldBlockedCaseInsensitiveRaw(t *testing.T) {
	s, _ := newShield(t, Config{})
	body := []byte("--b\r\nContent-Disposition: form-data; name=php_session_upload_progress\r\n\r\nx\r\n--b--\r\n")
	resp := post(t, s.URL, "multipart/form-data; boundary=b", body, nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}

func TestCustomProgressFieldName(t *testing.T) {
	s, _ := newShield(t, Config{ProgressFields: []string{"MY_PROGRESS"}})
	ct, body := multipartBody(t, [][2]string{{"MY_PROGRESS", "x"}}, 0)
	if resp := post(t, s.URL, ct, body, nil); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}

func TestMultipartContentTypeVariantsAreInspected(t *testing.T) {
	s, _ := newShield(t, Config{})
	_, body := multipartBody(t, [][2]string{{"PHP_SESSION_UPLOAD_PROGRESS", "x"}}, 0)
	for _, ct := range []string{"Multipart/Form-Data; boundary=x", "multipart/mixed; boundary=x", "text/plain; x=multipart"} {
		if resp := post(t, s.URL, ct, body, nil); resp.StatusCode != http.StatusForbidden {
			t.Errorf("ct %q: status = %d, want 403", ct, resp.StatusCode)
		}
	}
}

func TestDuplicateContentTypeRejected(t *testing.T) {
	s, events := newShield(t, Config{})
	req, _ := http.NewRequest("POST", s.URL, strings.NewReader("a=1"))
	req.Header.Add("Content-Type", "text/plain")
	req.Header.Add("Content-Type", "multipart/form-data; boundary=b")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if len(*events) != 1 || (*events)[0].Rule != RuleMalformedMultipart {
		t.Fatalf("events = %+v", *events)
	}
}

func TestOversizedBodyRejected(t *testing.T) {
	s, events := newShield(t, Config{MaxBodyBytes: 1024})
	resp := post(t, s.URL, "application/octet-stream", bytes.Repeat([]byte("a"), 2048), nil)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
	if len(*events) != 1 || (*events)[0].Rule != RuleBodyTooLarge {
		t.Fatalf("events = %+v", *events)
	}
}

func TestOversizedChunkedBodyRejected(t *testing.T) {
	s, _ := newShield(t, Config{MaxBodyBytes: 1024})
	req, _ := http.NewRequest("POST", s.URL, io.MultiReader(strings.NewReader(strings.Repeat("a", 4096))))
	req.ContentLength = -1 // force chunked
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
}

func TestTooManyPartsRejected(t *testing.T) {
	s, events := newShield(t, Config{MaxParts: 10})
	ct, body := multipartBody(t, nil, 11)
	if resp := post(t, s.URL, ct, body, nil); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
	if len(*events) != 1 || (*events)[0].Rule != RuleTooManyParts {
		t.Fatalf("events = %+v", *events)
	}
}

// GHSA-w8hw: many small part headers expand into far more memory inside PHP
// while the body stays small.
func TestPartHeaderAmplificationRejected(t *testing.T) {
	s, events := newShield(t, Config{})
	var b strings.Builder
	b.WriteString("--b\r\nContent-Disposition: form-data; name=a\r\n")
	for i := 0; i < 50; i++ {
		fmt.Fprintf(&b, "X-H%d: v\r\n", i)
	}
	b.WriteString("\r\nx\r\n--b--\r\n")
	resp := post(t, s.URL, "multipart/form-data; boundary=b", []byte(b.String()), nil)
	if resp.StatusCode != http.StatusRequestHeaderFieldsTooLarge {
		t.Fatalf("status = %d, want 431", resp.StatusCode)
	}
	if len(*events) != 1 || (*events)[0].Rule != RulePartHeaders {
		t.Fatalf("events = %+v", *events)
	}
}

func TestRepeatedPartHeaderCounted(t *testing.T) {
	s, _ := newShield(t, Config{MaxPartHeaders: 4})
	body := "--b\r\nContent-Disposition: form-data; name=a\r\n" +
		strings.Repeat("X: v\r\n", 5) + "\r\nx\r\n--b--\r\n"
	if resp := post(t, s.URL, "multipart/form-data; boundary=b", []byte(body), nil); resp.StatusCode != http.StatusRequestHeaderFieldsTooLarge {
		t.Fatalf("status = %d, want 431", resp.StatusCode)
	}
}

func TestLargePartHeaderRejected(t *testing.T) {
	s, _ := newShield(t, Config{})
	body := "--b\r\nContent-Disposition: form-data; name=a; filename=\"" +
		strings.Repeat("a", 10000) + "\"\r\n\r\nx\r\n--b--\r\n"
	if resp := post(t, s.URL, "multipart/form-data; boundary=b", []byte(body), nil); resp.StatusCode != http.StatusRequestHeaderFieldsTooLarge {
		t.Fatalf("status = %d, want 431", resp.StatusCode)
	}
}

func TestDeepFieldNestingRejected(t *testing.T) {
	s, events := newShield(t, Config{})
	ct, body := multipartBody(t, [][2]string{{"a" + strings.Repeat("[x]", 20), "1"}}, 0)
	if resp := post(t, s.URL, ct, body, nil); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if len(*events) != 1 || (*events)[0].Rule != RuleFieldNesting {
		t.Fatalf("events = %+v", *events)
	}
}

func TestModerateFieldNestingAllowed(t *testing.T) {
	s, _ := newShield(t, Config{})
	ct, body := multipartBody(t, [][2]string{{"user[address][city]", "x"}, {"tags[]", "y"}}, 0)
	if resp := post(t, s.URL, ct, body, nil); resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

func TestBlockMultipart(t *testing.T) {
	s, events := newShield(t, Config{BlockMultipart: true})
	ct, body := multipartBody(t, [][2]string{{"a", "b"}}, 0)
	if resp := post(t, s.URL, ct, body, nil); resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", resp.StatusCode)
	}
	if len(*events) != 1 || (*events)[0].Rule != RuleMultipartBlocked {
		t.Fatalf("events = %+v", *events)
	}
	if resp := post(t, s.URL, "application/x-www-form-urlencoded", []byte("a=b"), nil); resp.StatusCode != 200 {
		t.Fatalf("urlencoded status = %d, want 200", resp.StatusCode)
	}
}

func TestMalformedMultipartRejected(t *testing.T) {
	s, events := newShield(t, Config{})
	body := []byte("--b\r\nContent-Disposition: form-data; name=a\r\n\r\nunterminated")
	if resp := post(t, s.URL, "multipart/form-data; boundary=b", body, nil); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if len(*events) != 1 || (*events)[0].Rule != RuleMalformedMultipart {
		t.Fatalf("events = %+v", *events)
	}
}

func TestLogOnlyModeForwards(t *testing.T) {
	s, events := newShield(t, Config{LogOnly: true})
	ct, body := multipartBody(t, [][2]string{{"PHP_SESSION_UPLOAD_PROGRESS", "x"}}, 0)
	if resp := post(t, s.URL, ct, body, nil); resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(*events) != 1 || !(*events)[0].LogOnly {
		t.Fatalf("events = %+v", *events)
	}
}

func TestNormalSessionCookieKept(t *testing.T) {
	s, events := newShield(t, Config{})
	resp := post(t, s.URL, "text/plain", nil, map[string]string{
		"X-Test-Cookie": "PHPSESSID=k3j4h5g6f7d8s9a0q1w2e3r4t5; path=/",
	})
	if len(resp.Cookies()) != 2 {
		t.Fatalf("cookies = %v", resp.Header.Values("Set-Cookie"))
	}
	if len(*events) != 0 {
		t.Fatalf("unexpected events: %+v", *events)
	}
}

func TestLeakingSessionCookieStripped(t *testing.T) {
	s, events := newShield(t, Config{})
	resp := post(t, s.URL, "text/plain", nil, map[string]string{
		"X-Test-Cookie": "PHPSESSID=%00%00%A8%7F%00%00secret%3Dhunter2; path=/",
	})
	for _, c := range resp.Header.Values("Set-Cookie") {
		if strings.HasPrefix(c, "PHPSESSID=") {
			t.Fatalf("leaking cookie forwarded: %q", c)
		}
	}
	if len(resp.Header.Values("Set-Cookie")) != 1 {
		t.Fatalf("unrelated cookie dropped: %v", resp.Header.Values("Set-Cookie"))
	}
	if len(*events) != 1 || (*events)[0].Rule != RuleSessionCookieLeak {
		t.Fatalf("events = %+v", *events)
	}
}

func TestOverlongSessionCookieStripped(t *testing.T) {
	s, _ := newShield(t, Config{})
	resp := post(t, s.URL, "text/plain", nil, map[string]string{
		"X-Test-Cookie": "PHPSESSID=" + strings.Repeat("a", 300),
	})
	for _, c := range resp.Header.Values("Set-Cookie") {
		if strings.HasPrefix(c, "PHPSESSID=") {
			t.Fatal("overlong cookie forwarded")
		}
	}
}

func TestSessionCookieNameCaseInsensitive(t *testing.T) {
	s, _ := newShield(t, Config{})
	resp := post(t, s.URL, "text/plain", nil, map[string]string{
		"X-Test-Cookie": "phpsessid=%00%01",
	})
	if len(resp.Header.Values("Set-Cookie")) != 1 {
		t.Fatalf("cookies = %v", resp.Header.Values("Set-Cookie"))
	}
}

func TestDeletionCookieKept(t *testing.T) {
	s, events := newShield(t, Config{})
	resp := post(t, s.URL, "text/plain", nil, map[string]string{
		"X-Test-Cookie": "PHPSESSID=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT",
	})
	if len(resp.Header.Values("Set-Cookie")) != 2 || len(*events) != 0 {
		t.Fatalf("cookies = %v events = %+v", resp.Header.Values("Set-Cookie"), *events)
	}
}

func TestNewRejectsBadUpstream(t *testing.T) {
	if _, err := New(Config{Upstream: "::nope"}); err == nil {
		t.Fatal("want error")
	}
	if _, err := New(Config{}); err == nil {
		t.Fatal("want error for empty upstream")
	}
}
