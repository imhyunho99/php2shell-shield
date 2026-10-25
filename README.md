# php2shell-shield

[한국어](README.ko.md) · [Write-up (Korean)](https://im-hyunho99.tistory.com/51)

Stopgap protection for **PHP2Shell** (CVE-2026-109618, CVE-2026-109619) for servers that can't upgrade PHP today.

- **`php2shell-shield`**: a small Go reverse proxy you put in front of your PHP web server. It blocks the request shapes the published attack paths need and strips leaked memory from responses.
- **`php2shell-check`**: tells you whether a PHP build is patched, partially mitigated, or vulnerable, based on `php -i` output.
- **A Claude Code skill** that walks an agent through finding, patching, and auditing every PHP install in a repo or on a host.

> **Upgrade PHP.** 8.5.12, 8.4.27, 8.3.36 and 8.2.35 fix both bugs (so does 8.6.0 RC4). PHP's own words: "There are no complete mitigations, updating is the only safe choice." This project narrows some attack paths while you get there. It does not make a server safe.

## What PHP2Shell is

Two bugs in the PHP engine, each rated CVSS v4.0 9.2:

- **CVE-2026-109618, OOM corruption.** PHP aborts a request on out-of-memory. If memory runs out while request data is only partly initialized, cleanup treats that data as valid.
- **CVE-2026-109619, stale global state.** Request-owned state (error, session, backtrace, extension state) outlives its freed memory, and the next request on the same worker uses it.

An attacker uses one request to plant the state and a second one to trigger its use. The confirmed paths:

1. **Session upload progress.** Enabled by default, and it runs without `session_start()`. Multipart parsing at request startup publishes session state. An OOM then leaves it dangling. Wiz showed this leaking worker heap, URL-encoded, through the session cookie.
2. **Fatal error backtraces (PHP 8.5).** The strongest case: confirmed RCE on mod_php.
3. **INI diagnostics before startup.** Any warning or deprecation raised while per-request INI values are applied, for example from `.htaccess` or `php_value` under mod_php.
4. **Diagnostics during shutdown and cleanup**, plus other error, exception, and extension state that depends on the app.

The OOM doesn't need a big body. A part can carry any number of headers, and those cost PHP far more memory than they take on the wire. Empty file fields and deeply nested field names multiply the work. Multipart sent without a usable `Content-Length` can get past `post_max_size`.

All PHP installations serving web requests are affected: PHP-FPM, mod_php, php-cgi, FrankenPHP, LiteSpeed. PHP rates mod_php highest risk. RCE was also validated on FPM. PHP's advisories set no lower version bound. Wiz reports versions back to 5.4 are affected.

## What the shield does, and doesn't

| Check | Covers |
|---|---|
| Refuses multipart containing the upload-progress field (403) | Path 1 trigger. Raw-byte, case-insensitive match, so parser differences can't hide it. Set `-progress-fields` if you changed `session.upload_progress.name`. |
| Caps headers per multipart part (8, 4 KiB; 431) | Header amplification OOM |
| Caps `[` nesting in field names (8; 400) | Nested-name amplification |
| Caps multipart parts (1000; 413) | Empty-file-field and part-count amplification |
| Caps body size (16 MiB; 413), chunked included | Requests are buffered and forwarded with a real `Content-Length`, so the no-`Content-Length` trick doesn't reach PHP |
| Refuses unparseable multipart or duplicate `Content-Type` (400) | Parser differentials. The shield fails closed. |
| `-block-multipart` (415) | PHP's advice for apps with no uploads |
| Drops session `Set-Cookie` values that aren't valid session IDs | The memory leak channel. Real IDs use only `[0-9A-Za-z,-]` and are at most 256 chars. Set `-session-cookies` if you changed `session.name`. |

It **can't** see paths 2–4. They happen inside PHP: fatal errors in your app, INI diagnostics, shutdown warnings. Those need the PHP settings below and, really, the upgrade. It also can't stop app-specific OOM, any variant nobody has published, or attackers who reach PHP without going through the shield.

Every match is logged to stdout as one JSON line. Use `-log-only` to look for false positives before enforcing.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/imhyunho99/php2shell-shield/main/install.sh | sh
```

Linux and macOS, amd64 and arm64. It downloads the latest release and checks its SHA-256 before installing to `/usr/local/bin` (`PREFIX=` to change). Or:

- Binaries for Linux, macOS and Windows: [Releases](https://github.com/imhyunho99/php2shell-shield/releases) (with `SHA256SUMS`)
- Container: `ghcr.io/imhyunho99/php2shell-shield:latest` (amd64, arm64)
- From source: `go install github.com/imhyunho99/php2shell-shield/cmd/...@latest`

## Quick start

```sh
# 1. Is this PHP exposed? Check the web SAPI, not only the CLI.
php2shell-check -php php-fpm8.3
docker exec web php -i | php2shell-check -stdin

# 2. Move the web server to an internal port, then put the shield in front.
php2shell-shield -listen :80 -upstream http://127.0.0.1:8080
```

`php2shell-check` prints the shield flags you need if your `session.name` or `session.upload_progress.name` isn't the default.

Deployment examples:

- [`deploy/docker-compose.yml`](deploy/docker-compose.yml): shield in front of a PHP container, with PHP kept on an internal network
- [`deploy/nginx/php2shell.conf`](deploy/nginx/php2shell.conf): nginx terminates TLS, then the shield, then the PHP-FPM vhost on localhost
- [`deploy/systemd/php2shell-shield.service`](deploy/systemd/php2shell-shield.service): sandboxed systemd unit

To terminate TLS in the shield itself, pass `-tls-cert` and `-tls-key`. Whatever the layout, make sure nothing else exposes PHP.

### Flags

| Flag | Default | |
|---|---|---|
| `-upstream` | (required) | PHP web server URL |
| `-listen` | `:8080` | |
| `-max-body` | `16777216` | bytes; PHP suggests `post_max_size` 8M without uploads, 32M with |
| `-max-parts` | `1000` | |
| `-max-part-headers` | `8` | headers inside one multipart part |
| `-max-part-header-bytes` | `4096` | |
| `-max-nesting` | `8` | `[ ]` depth in multipart field names |
| `-block-multipart` | `false` | refuse all multipart; use if the app takes no uploads |
| `-progress-fields` | `PHP_SESSION_UPLOAD_PROGRESS` | your `session.upload_progress.name`, comma-separated |
| `-session-cookies` | `PHPSESSID` | your `session.name`, comma-separated |
| `-upstream-conns` | `256` | idle keep-alive connections to the upstream |
| `-log-only` | `false` | log matches, block nothing |

The shield buffers each request body (up to `-max-body`) in memory. Size the host for that.

## Tested

- **Unit tests** for every rule, plus a concurrency test for upstream connection reuse.
- **e2e in CI**: real `php:8.3-apache` behind the shield. Sessions and uploads pass, and each attack shape is refused.
- **WordPress 6 (`wordpress:php8.3-apache`) behind the shield**, driven by a real browser (Playwright): login, classic and async media upload, REST post publishing, settings form, visitor comment. 0 requests blocked, 0 errors.
- **Throughput** (wrk, 32 connections, Docker Desktop on an M-series Mac, same PHP container):

  | | direct | through shield |
  |---|---|---|
  | `GET` tiny PHP page | 23.3k req/s | 11.5k req/s |
  | 1 MiB multipart upload | 159 req/s | 151 req/s |

  The shield adds a few ms per request. For real pages, PHP is the bottleneck. Memory stayed under 75 MiB.

Not tested: real PHP2Shell exploits. No public exploit exists, and the rules come from the request shapes the advisories describe.

## Interim PHP settings

From the [php.net advisory](https://www.php.net/archive/2026.php). PHP says they "reduce exposure to specific attack paths but do not make an installation safe." Set them in `php.ini`, the FPM pool (`php_admin_value`) or the server config, not with `ini_set()` or `.user.ini`. Then restart every worker.

```ini
memory_limit = -1                   ; 109618. Check no pool/dir/app sets a finite limit back.
session.upload_progress.enabled = 0 ; 109619 session path. Keep it off after patching if unused.
fatal_error_backtraces = 0          ; 109619, PHP 8.5 only
post_max_size = 8M                  ; 32M if you need uploads; upload_max_filesize below it
```

Also:

- Bound memory with a cgroup or container limit, ideally one that kills only the affected worker. **Do not** use `RLIMIT_AS` / `RLIMIT_DATA`: hitting them is exactly the failure that triggers the bug.
- Remove invalid or deprecated per-request INI settings that emit diagnostics before startup. Hiding them with `@`, `error_reporting` or `display_errors` doesn't help.
- Fix fatal errors and execution timeouts that attackers can reach: uploads, imports, error pages, callbacks, destructors, shutdown.
- If you can afford it, `pm.max_requests = 1` recycles FPM workers after every request.

`php2shell-check` reports `PARTIALLY MITIGATED` when the first three are set.

## `php2shell-check` exit codes

| Code | Status |
|---|---|
| 0 | `PATCHED` |
| 1 | `PARTIALLY MITIGATED`, or `UNKNOWN` (distro build, EOL 7.4–8.1 where a source backport may be applied, or older than any version named in reports) |
| 2 | `VULNERABLE` |

Use it as a CI gate: `docker run --rm your-image php -i | php2shell-check -stdin`.

## Claude Code skill

```sh
mkdir -p ~/.claude/skills
cp -r skills/php2shell-response ~/.claude/skills/
```

Then ask Claude Code something like "are we affected by PHP2Shell?" The skill tells it to inventory every PHP (Dockerfiles, CI, composer platform, hosts), check the web SAPI, patch before mitigating, and hunt for signs of compromise. It also stops the agent from calling a system safe on the strength of mitigations or the shield.

## Signs of compromise

AWS reports exploitation attempts in its honeypots before the 2026-10-21 disclosure. Start your review from at least mid-October.

- bursts of 500s, `Allowed memory size … exhausted`, fatal errors or timeouts, especially on multipart POSTs
- session cookies in responses containing `%`, or longer than 256 chars (the shield logs these as `session-cookie-leak`)
- unexplained PHP worker crashes or restarts
- new `.php` files in web roots or upload directories

Clean logs don't prove anything: some failures happen before PHP writes a message. If you find any of the above, assume secrets in worker memory are exposed. Rotate DB passwords, API keys, and session signing keys, invalidate sessions, and rebuild from known-good images.

## References

- [php.net security advisory, 2026-10-21](https://www.php.net/archive/2026.php)
- [GHSA-w8hw-w9fx-j79w (CVE-2026-109618)](https://github.com/php/php-src/security/advisories/GHSA-w8hw-w9fx-j79w)
- [GHSA-6wmf-4rv5-p3rp (CVE-2026-109619)](https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp)
- [Wiz: PHP2Shell](https://www.wiz.io/blog/php2shell-php-rce)
- [AWS: WAF mitigations for PHP2Shell](https://aws.amazon.com/blogs/security/using-aws-waf-to-apply-mitigations-for-php2shell-rce-vulnerabilities-cve-2026-109618-and-cve-2026-109619/)

## Development

```sh
go test -race ./...   # unit tests
test/e2e/run.sh       # real php:8.3-apache behind the shield (needs Docker)
```

Bypasses: see [SECURITY.md](SECURITY.md).

## License

MIT
