// Package check decides whether a PHP build is exposed to PHP2Shell
// (CVE-2026-109618, CVE-2026-109619) from its `php -i` output.
package check

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type Status int

const (
	Unknown Status = iota
	Patched
	Mitigated
	Vulnerable
)

func (s Status) String() string {
	return [...]string{"UNKNOWN", "PATCHED", "PARTIALLY MITIGATED", "VULNERABLE"}[s]
}

type Info struct {
	Version string
	INI     map[string]string
}

type Result struct {
	Status Status
	Notes  []string
}

// First fixed patch release per branch (php.net, 2026-10-21).
var fixed = map[[2]int]int{
	{8, 5}: 12,
	{8, 4}: 27,
	{8, 3}: 36,
	{8, 2}: 35,
}

var versionRe = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(.*)$`)

// ParsePHPInfo reads the text form of phpinfo() (`php -i`, `php-fpm -i`).
// For directives it keeps the local value, which is what requests see.
func ParsePHPInfo(out string) Info {
	info := Info{INI: map[string]string{}}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(line, " => ")
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSpace(fields[0])
		if key == "PHP Version" && info.Version == "" {
			info.Version = strings.TrimSpace(fields[1])
			continue
		}
		if len(fields) == 3 {
			info.INI[key] = strings.TrimSpace(fields[1])
		}
	}
	return info
}

func Evaluate(info Info) Result {
	m := versionRe.FindStringSubmatch(info.Version)
	if m == nil {
		return Result{Unknown, []string{fmt.Sprintf("could not parse PHP version %q", info.Version)}}
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	patch, _ := strconv.Atoi(m[3])
	distro := m[4] != ""
	v := fmt.Sprintf("%d.%d.%d", major, minor, patch)

	if major > 8 || (major == 8 && minor > 5) {
		return Result{Patched, []string{v + " is newer than every affected branch"}}
	}
	if first, ok := fixed[[2]int{major, minor}]; ok && patch >= first {
		return Result{Patched, []string{fmt.Sprintf("%s >= %d.%d.%d", v, major, minor, first)}}
	}

	var notes []string
	status := Vulnerable
	switch first, ok := fixed[[2]int{major, minor}]; {
	case ok && distro:
		status = Unknown
		notes = append(notes, fmt.Sprintf("distro build %s is below upstream %d.%d.%d; vendors backport fixes without bumping the version, so check your vendor's advisory", info.Version, major, minor, first))
	case ok:
		notes = append(notes, fmt.Sprintf("%s is vulnerable; upgrade to %d.%d.%d or later", v, major, minor, first))
	case major == 8 || (major == 7 && minor == 4):
		status = Unknown
		notes = append(notes, v+" is EOL; PHP published source backports (branch PHP-"+fmt.Sprintf("%d.%d", major, minor)+"-CVE-2026-109618-109619) but no release. Patched only if you or your vendor applied them")
	case major < 5 || (major == 5 && minor < 4):
		status = Unknown
		notes = append(notes, v+" is older than any version researchers name (Wiz: back to 5.4); PHP gives no lower bound. It is long EOL either way")
	default:
		notes = append(notes, v+" is EOL and gets no fix from PHP; move to 8.2+ or isolate it")
	}

	mitigated, mnotes := mitigations(major, minor, info.INI)
	notes = append(notes, mnotes...)
	notes = append(notes, shieldFlags(info.INI)...)
	if mitigated && status == Vulnerable {
		status = Mitigated
	}
	return Result{status, notes}
}

// mitigations checks the interim settings from the PHP advisory. PHP says
// none of them make an installation safe; they close specific paths.
func mitigations(major, minor int, ini map[string]string) (bool, []string) {
	ok := true
	var notes []string
	if ini["memory_limit"] == "-1" {
		notes = append(notes, "ok: memory_limit=-1 (CVE-2026-109618); bound memory with a cgroup/container limit, never RLIMIT_AS/RLIMIT_DATA")
	} else {
		ok = false
		notes = append(notes, fmt.Sprintf("set memory_limit=-1 via php_admin_value or server config (CVE-2026-109618); now %q", ini["memory_limit"]))
	}
	if off(ini["session.upload_progress.enabled"]) {
		notes = append(notes, "ok: session.upload_progress.enabled=0 (CVE-2026-109619 session path)")
	} else {
		ok = false
		notes = append(notes, fmt.Sprintf("set session.upload_progress.enabled=0 in php.ini or the pool, not ini_set()/.user.ini (CVE-2026-109619); now %q", ini["session.upload_progress.enabled"]))
	}
	if major == 8 && minor == 5 {
		if off(ini["fatal_error_backtraces"]) {
			notes = append(notes, "ok: fatal_error_backtraces=0")
		} else {
			ok = false
			notes = append(notes, fmt.Sprintf("set fatal_error_backtraces=0 (8.5's confirmed RCE path); now %q", ini["fatal_error_backtraces"]))
		}
	}
	if size := parseSize(ini["post_max_size"]); size > 32<<20 || size == 0 {
		notes = append(notes, fmt.Sprintf("lower post_max_size to 8M (no uploads) or 32M (uploads), upload_max_filesize below it; now %q", ini["post_max_size"]))
	}
	notes = append(notes, "no configuration fully mitigates PHP2Shell: restart every worker after changes, remove deprecated/invalid per-request INI settings, fix attacker-reachable fatal errors and timeouts, and upgrade")
	return ok, notes
}

// shieldFlags tells the user which php2shell-shield flags match a
// non-default session config.
func shieldFlags(ini map[string]string) []string {
	var notes []string
	if n := ini["session.name"]; n != "" && n != "PHPSESSID" {
		notes = append(notes, "run php2shell-shield with -session-cookies "+n)
	}
	if n := ini["session.upload_progress.name"]; n != "" && n != "PHP_SESSION_UPLOAD_PROGRESS" {
		notes = append(notes, "run php2shell-shield with -progress-fields "+n)
	}
	return notes
}

// parseSize reads PHP shorthand byte values (8M, 1G, 512K). -1 if invalid.
func parseSize(v string) int64 {
	v = strings.TrimSpace(v)
	if v == "" {
		return -1
	}
	mult := int64(1)
	switch strings.ToUpper(v[len(v)-1:]) {
	case "K":
		mult = 1 << 10
	case "M":
		mult = 1 << 20
	case "G":
		mult = 1 << 30
	}
	if mult != 1 {
		v = v[:len(v)-1]
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return -1
	}
	return n * mult
}

func off(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "0", "off", "false", "no":
		return true
	}
	return false
}
