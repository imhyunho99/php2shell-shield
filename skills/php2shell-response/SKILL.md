---
name: php2shell-response
description: Respond to PHP2Shell (CVE-2026-109618, CVE-2026-109619) on a server or codebase. Use when the user asks whether their PHP is affected, how to patch or mitigate PHP2Shell, or to check servers, Dockerfiles, CI images or hosting configs for vulnerable PHP versions.
---

# PHP2Shell response

PHP2Shell is a pair of PHP engine bugs disclosed 2026-10-21, each rated CVSS
v4.0 9.2:

- **CVE-2026-109618** ([GHSA-w8hw-w9fx-j79w](https://github.com/php/php-src/security/advisories/GHSA-w8hw-w9fx-j79w)):
  out-of-memory while request data is half initialized, so cleanup trusts garbage.
- **CVE-2026-109619** ([GHSA-6wmf-4rv5-p3rp](https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp)):
  request state outlives its memory and the next request on the same worker uses it.

Confirmed paths: session upload progress (on by default, no `session_start()`
needed), fatal error backtraces on 8.5 (confirmed mod_php RCE), INI
diagnostics before request startup, and shutdown diagnostics. PHP rates mod_php
the highest risk, and RCE was also validated on FPM. Every SAPI that serves web
requests is affected.

Fixed releases: **8.5.12, 8.4.27, 8.3.36, 8.2.35** (and 8.6.0 RC4). For 7.4,
8.0 and 8.1 PHP published source-backport branches
(`PHP-x.y-CVE-2026-109618-109619`), not releases. Nothing for older branches.
PHP's advisories give no lower version bound. Wiz reports versions back to 5.4
are affected.

AWS saw exploitation attempts before disclosure. Treat anything exposed since
mid-October as possibly compromised, not only possibly vulnerable.

## Order of work

Do these in order. Stop and report after each step that changes a live system.

### 1. Find every PHP

Search the repo and the host, not just the obvious app:

- `Dockerfile*`, `docker-compose*`, k8s manifests, Helm values: `FROM php:`, `php-fpm`, `phpX.Y-` packages
- CI configs: `setup-php`, `php-version:`
- `composer.json` `config.platform.php` and `require.php`
- Hosting configs: `.platform.app.yaml`, `app.yaml` (`runtime: php`), Heroku/Render buildpacks
- On a host: `which -a php php-fpm php-cgi`, `ls /usr/sbin/php-fpm*`, `ls /etc/php/`

Report the list before changing anything.

### 2. Measure each one

Run the checker against the **web** SAPI, not only the CLI, since they often load
different ini files:

```sh
php2shell-check -php php-fpm8.3
docker exec <container> php -i | php2shell-check -stdin
```

Exit 0 means patched. Exit 1 means partially mitigated or unknown. Exit 2 means vulnerable.
Distro builds (`8.3.6-0ubuntu…`) report UNKNOWN because vendors backport
without bumping the version. Check the vendor advisory (Ubuntu USN, Debian DSA,
RHSA) for the exact package version that carries the fix.

### 3. Patch

This is the only complete fix. Bump image tags or packages to the fixed release
for the same minor branch, rebuild and redeploy. Then restart every PHP worker
(`systemctl restart php8.3-fpm`, `apachectl graceful` for mod_php). Re-run step 2
and show the output.

For 8.1 and older: say plainly that the branch is EOL, and recommend moving to
8.2+. Do not invent a patched 8.1 version number.

### 4. If patching must wait

PHP says these "reduce exposure to specific attack paths but do not make an
installation safe". Set them in `php.ini`, the FPM pool (`php_admin_value`) or
server config, never `ini_set()` or `.user.ini`, then restart every worker:

```ini
memory_limit = -1                   ; check nothing sets a finite limit back
session.upload_progress.enabled = 0
fatal_error_backtraces = 0          ; PHP 8.5 only
post_max_size = 8M                  ; 32M if uploads are needed
```

Also:

- Bound memory with a cgroup/container limit. Never `RLIMIT_AS`/`RLIMIT_DATA`:
  hitting those triggers the bug.
- Find and remove invalid or deprecated INI settings applied per request
  (`.htaccess`, `php_value`, `PHP_VALUE` from the frontend). Run with
  `log_errors=On`, `error_reporting=E_ALL` in an isolated environment and look
  for warnings before the script starts. Suppressing them does not help.
- Look in the app for fatal errors and timeouts an attacker can reach (uploads,
  imports, error pages, destructors, shutdown functions) and report them.
- Suggest `pm.max_requests = 1` if the load allows.

Then put `php2shell-shield` in front of the web server (see the repo README).
If `php -i` shows a non-default `session.name` or
`session.upload_progress.name`, pass them with `-session-cookies` /
`-progress-fields`. If the app takes no uploads, add `-block-multipart`. Tell
the user what it covers and what it doesn't. It blocks the upload-progress
trigger, multipart amplification and the cookie leak. It cannot see fatal
backtraces, INI diagnostics or shutdown paths.

If none of this can happen today, recommend taking the service off the public
internet until it can.

### 5. Look for compromise

From mid-October onward:

- Bursts of HTTP 500, `Allowed memory size … exhausted`, fatal errors or timeouts, especially on multipart POSTs
- Session response cookies containing `%` or longer than 256 chars
- Unexplained PHP worker restarts or crashes
- New or modified `.php` files in web roots and upload dirs:
  `find /var/www -name '*.php' -newermt 2026-10-14`
- Outbound connections from PHP workers

Clean logs do not prove safety. If any of these turn up, say so plainly and
recommend incident response: rotate secrets that were in worker memory (DB
passwords, API keys, session signing keys), invalidate sessions, and rebuild
from known-good images.

## Rules

- Never claim a system is safe on the basis of mitigations or the shield alone.
- Never run exploit code or proof-of-concept payloads against anything.
- Quote version numbers from this file or the PHP advisory, not from memory.
