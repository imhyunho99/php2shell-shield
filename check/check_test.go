package check

import (
	"strings"
	"testing"
)

func info(version string, kv ...string) string {
	var b strings.Builder
	b.WriteString("phpinfo()\nPHP Version => " + version + "\n\nSystem => Linux\n")
	for i := 0; i < len(kv); i += 2 {
		b.WriteString(kv[i] + " => " + kv[i+1] + " => " + kv[i+1] + "\n")
	}
	return b.String()
}

func TestParsePHPInfo(t *testing.T) {
	got := ParsePHPInfo(info("8.3.10", "memory_limit", "128M", "session.upload_progress.enabled", "On"))
	if got.Version != "8.3.10" || got.INI["memory_limit"] != "128M" || got.INI["session.upload_progress.enabled"] != "On" {
		t.Fatalf("got %+v", got)
	}
}

func TestParsePHPInfoUsesLocalValue(t *testing.T) {
	got := ParsePHPInfo("PHP Version => 8.4.1\nmemory_limit => -1 => 128M\n")
	if got.INI["memory_limit"] != "-1" {
		t.Fatalf("memory_limit = %q, want local value -1", got.INI["memory_limit"])
	}
}

func TestEvaluate(t *testing.T) {
	cases := []struct {
		name    string
		version string
		ini     []string
		want    Status
	}{
		{"8.5 patched", "8.5.12", nil, Patched},
		{"8.4 patched", "8.4.30", nil, Patched},
		{"8.3 patched", "8.3.36", nil, Patched},
		{"8.2 patched", "8.2.35", nil, Patched},
		{"9.x assumed patched", "9.0.0", nil, Patched},
		{"8.3 vulnerable", "8.3.35", []string{"memory_limit", "128M", "session.upload_progress.enabled", "On"}, Vulnerable},
		{"8.2 vulnerable no mitigation", "8.2.34", nil, Vulnerable},
		{"8.3 fully mitigated", "8.3.20", []string{"memory_limit", "-1", "session.upload_progress.enabled", "Off"}, Mitigated},
		{"8.3 half mitigated", "8.3.20", []string{"memory_limit", "-1", "session.upload_progress.enabled", "On"}, Vulnerable},
		{"8.5 needs backtraces off", "8.5.11", []string{"memory_limit", "-1", "session.upload_progress.enabled", "0", "fatal_error_backtraces", "On"}, Vulnerable},
		{"8.5 fully mitigated", "8.5.11", []string{"memory_limit", "-1", "session.upload_progress.enabled", "0", "fatal_error_backtraces", "Off"}, Mitigated},
		{"8.1 backport-only", "8.1.31", nil, Unknown},
		{"7.4 backport-only", "7.4.33", nil, Unknown},
		{"7.3 eol", "7.3.33", nil, Vulnerable},
		{"5.4 eol", "5.4.45", nil, Vulnerable},
		{"5.3 predates bug", "5.3.29", nil, NotAffected},
		{"distro build below fixed", "8.3.6-0ubuntu0.24.04.5", nil, Unknown},
		{"distro build at fixed", "8.3.36-1+deb12u1", nil, Patched},
		{"garbage", "", nil, Unknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ini := map[string]string{}
			for i := 0; i < len(c.ini); i += 2 {
				ini[c.ini[i]] = c.ini[i+1]
			}
			r := Evaluate(Info{Version: c.version, INI: ini})
			if r.Status != c.want {
				t.Fatalf("status = %v, want %v (notes: %v)", r.Status, c.want, r.Notes)
			}
			if len(r.Notes) == 0 {
				t.Fatal("no notes")
			}
		})
	}
}
