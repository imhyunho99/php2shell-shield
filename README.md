# php2shell-shield

[한국어](README.ko.md)

Stopgap protection for **PHP2Shell** (CVE-2026-109618, CVE-2026-109619) for servers that can't upgrade PHP today.

- **`php2shell-shield`**: a small Go reverse proxy you put in front of your PHP web server. It blocks the request shapes PHP2Shell uses and strips leaked memory from responses.
- **`php2shell-check`**: tells you whether a PHP build is patched, mitigated, or vulnerable, based on `php -i` output.
- **A Claude Code skill** that walks an agent through finding, patching, and auditing every PHP install in a repo or on a host.

> **Upgrade PHP.** 8.5.12, 8.4.27, 8.3.36 and 8.2.35 fix the bugs, and upgrading is the only complete fix. This project buys time and nothing more.

## What PHP2Shell does

An unauthenticated request drives a PHP worker into an out-of-memory error partway through request startup. That leaves global state pointing at freed memory, and the next request on the same worker uses it. The documented chains go through multipart parsing and session upload-progress handling. One of them URL-encodes worker heap memory into the `PHPSESSID` response cookie, even when the app never calls `session_start()`. Every PHP from 5.4 through 8.5.11 is affected by at least one of the bugs. Exploitation was observed from 2026-10-17.

## What the shield does

| Check | Why |
|---|---|
| Refuses multipart bodies containing `PHP_SESSION_UPLOAD_PROGRESS` (403) | Upload-progress handling is on the published attack path. The match runs on raw bytes, case-insensitively, so parser differences can't hide it. |
| Caps body size (default 16 MiB, 413) | Large payloads are how a worker gets pushed into out-of-memory. |
| Caps multipart parts (default 1000, 413) | Same reason. |
| Refuses multipart it can't parse (400) | If Go and PHP disagree on framing, the shield fails closed. |
| Drops `Set-Cookie: PHPSESSID=…` values that aren't valid session IDs | That cookie is the leak channel. Real IDs only use `[0-9A-Za-z,-]` and are at most 256 chars. |

Every match is logged to stdout as one JSON line. Use `-log-only` to watch traffic for false positives before enforcing.

What it does **not** do: patch PHP, see FastCGI traffic, protect against vectors that haven't been published, or help if attackers can reach PHP without going through it.

## Install

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

Deployment examples:

- [`deploy/docker-compose.yml`](deploy/docker-compose.yml): shield in front of a PHP container, with PHP kept on an internal network
- [`deploy/nginx/php2shell.conf`](deploy/nginx/php2shell.conf): nginx terminates TLS, then the shield, then the PHP-FPM vhost on localhost
- [`deploy/systemd/php2shell-shield.service`](deploy/systemd/php2shell-shield.service): sandboxed systemd unit

To terminate TLS in the shield itself, pass `-tls-cert` and `-tls-key`. Whatever the layout, make sure nothing else exposes PHP. The shield only helps if every request goes through it.

### Flags

| Flag | Default | |
|---|---|---|
| `-upstream` | (required) | PHP web server URL |
| `-listen` | `:8080` | |
| `-max-body` | `16777216` | bytes; raise it if you take larger uploads |
| `-max-parts` | `1000` | match `max_input_vars` |
| `-progress-fields` | `PHP_SESSION_UPLOAD_PROGRESS` | your `session.upload_progress.name`, comma-separated |
| `-session-cookies` | `PHPSESSID` | your `session.name`, comma-separated |
| `-log-only` | `false` | log matches, block nothing |

The shield buffers each request body (up to `-max-body`) in memory to inspect it. Size the host for that.

## Interim PHP settings

From the PHP advisory. Put them where applications can't override them (the main `php.ini` or `php_admin_value` in the FPM pool), then restart every worker:

```ini
memory_limit = -1                   ; CVE-2026-109618. Add a container/cgroup memory limit.
session.upload_progress.enabled = 0 ; CVE-2026-109619
fatal_error_backtraces = 0          ; PHP 8.5 only
```

`php2shell-check` reports a build as `MITIGATED` when all of these are set.

## `php2shell-check` exit codes

| Code | Status |
|---|---|
| 0 | `PATCHED` or `NOT AFFECTED` |
| 1 | `MITIGATED`, or `UNKNOWN` (distro build, or EOL 7.4–8.1 where a backport may have been applied) |
| 2 | `VULNERABLE` |

Use it as a CI gate: `docker run --rm your-image php -i | php2shell-check -stdin`.

## Claude Code skill

```sh
mkdir -p ~/.claude/skills
cp -r skills/php2shell-response ~/.claude/skills/
```

Then ask Claude Code something like "are we affected by PHP2Shell?" The skill tells it to inventory every PHP (Dockerfiles, CI, composer platform, hosts), check the web SAPI, patch before mitigating, and look for signs of compromise from 2026-10-17 on. It also stops the agent from calling a system safe just because the mitigations or the shield are in place.

## Signs of compromise

From 2026-10-17 on:

- bursts of 500s or `Allowed memory size … exhausted` on multipart POSTs
- `PHPSESSID` response cookies containing `%`, or longer than 256 chars (the shield logs these as `session-cookie-leak`)
- unexplained PHP worker crashes or restarts
- new `.php` files in web roots or upload directories

If you find any, assume secrets in worker memory are exposed. Rotate DB passwords, API keys, and session signing keys, and rebuild from known-good images.

## References

- [Wiz: PHP2Shell](https://www.wiz.io/blog/php2shell-php-rce)
- [Tenable FAQ](https://www.tenable.com/blog/php2shell-cve-2026-109618-cve-2026-109619-frequently-asked-questions-about-critical-php-remote)
- [Qualys](https://blog.qualys.com/vulnerabilities-threat-research/2026/10/20/php-announces-critical-security-release-for-two-vulnerabilities)
- [Google Cloud response](https://cloud.google.com/blog/products/identity-security/responding-to-core-php-vulnerabilities-cve-2026-109618-cve-2026-109619)

## Development

```sh
go test -race ./...   # unit tests
test/e2e/run.sh       # real php:8.3-apache behind the shield (needs Docker)
```

Bypasses: see [SECURITY.md](SECURITY.md).

## License

MIT
