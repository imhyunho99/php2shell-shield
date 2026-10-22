// Command php2shell-check reports whether a PHP binary is exposed to PHP2Shell.
//
//	php2shell-check                      # uses `php -i`
//	php2shell-check -php php-fpm8.3      # check the FPM build and its ini
//	php -i | php2shell-check -stdin      # e.g. from inside a container
//
// Exit status: 0 patched or not affected, 1 mitigated or unknown, 2 vulnerable.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"

	"github.com/imhyunho99/php2shell-shield/check"
)

var version = "dev" // set by -ldflags at release

func main() {
	bin := flag.String("php", "php", "PHP binary to run with -i (php, php-fpm, php-cgi, ...)")
	stdin := flag.Bool("stdin", false, "read phpinfo text from stdin instead of running a binary")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	var out []byte
	var err error
	if *stdin {
		out, err = io.ReadAll(os.Stdin)
	} else {
		out, err = exec.Command(*bin, "-i").Output()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "php2shell-check:", err)
		os.Exit(3)
	}

	info := check.ParsePHPInfo(string(out))
	r := check.Evaluate(info)
	fmt.Printf("PHP %s: %s\n", info.Version, r.Status)
	for _, n := range r.Notes {
		fmt.Println("  -", n)
	}
	if !*stdin {
		fmt.Printf("  - checked %s; the CLI may load a different php.ini than your web SAPI, so also run with -php <php-fpm binary>\n", *bin)
	}

	// 0 only when no action is needed, so CI can gate on it.
	switch r.Status {
	case check.Vulnerable:
		os.Exit(2)
	case check.Unknown, check.Mitigated:
		os.Exit(1)
	}
}
