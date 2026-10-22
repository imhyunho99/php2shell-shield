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
	NotAffected
	Patched
	Mitigated
	Vulnerable
)

func (s Status) String() string {
	return [...]string{"UNKNOWN", "NOT AFFECTED", "PATCHED", "MITIGATED", "VULNERABLE"}[s]
}

type Info struct {
	Version string
	INI     map[string]string
}

type Result struct {
	Status Status
	Notes  []string
}

// First fixed patch release per branch (PHP security release, 2026-10-21).
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

	switch {
	case major > 8 || (major == 8 && minor > 5):
		return Result{Patched, []string{v + " is newer than every affected branch"}}
	case major < 5 || (major == 5 && minor < 4):
		return Result{NotAffected, []string{v + " predates the affected code (5.4.0), but it is long EOL with other known holes"}}
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
		notes = append(notes, v+" is EOL; PHP published source backports for 7.4-8.1 only. Patched only if you or your vendor applied them")
	default:
		notes = append(notes, v+" is EOL and will not get a fix; move to 8.2+ or isolate it")
	}

	mitigated, mnotes := mitigations(major, minor, info.INI)
	notes = append(notes, mnotes...)
	if mitigated && status != NotAffected {
		status = Mitigated
	}
	return Result{status, notes}
}

// mitigations checks the interim settings from the PHP advisory.
func mitigations(major, minor int, ini map[string]string) (bool, []string) {
	ok := true
	var notes []string
	if ini["memory_limit"] == "-1" {
		notes = append(notes, "ok: memory_limit=-1 (CVE-2026-109618); keep a container/cgroup memory cap")
	} else {
		ok = false
		notes = append(notes, fmt.Sprintf("set memory_limit=-1 so apps cannot override it (CVE-2026-109618); now %q", ini["memory_limit"]))
	}
	if off(ini["session.upload_progress.enabled"]) {
		notes = append(notes, "ok: session.upload_progress.enabled=0 (CVE-2026-109619)")
	} else {
		ok = false
		notes = append(notes, fmt.Sprintf("set session.upload_progress.enabled=0 (CVE-2026-109619); now %q", ini["session.upload_progress.enabled"]))
	}
	if major == 8 && minor == 5 {
		if off(ini["fatal_error_backtraces"]) {
			notes = append(notes, "ok: fatal_error_backtraces=0")
		} else {
			ok = false
			notes = append(notes, fmt.Sprintf("set fatal_error_backtraces=0 on 8.5; now %q", ini["fatal_error_backtraces"]))
		}
	}
	if ok {
		notes = append(notes, "mitigations are a stopgap; restart every PHP worker after changing them and still upgrade")
	}
	return ok, notes
}

func off(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "0", "off", "false", "no":
		return true
	}
	return false
}
