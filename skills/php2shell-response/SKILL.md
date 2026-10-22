---
name: php2shell-response
description: Respond to PHP2Shell (CVE-2026-109618, CVE-2026-109619) on a server or codebase. Use when the user asks whether their PHP is affected, how to patch or mitigate PHP2Shell, or to check servers, Dockerfiles, CI images or hosting configs for vulnerable PHP versions.
---

# PHP2Shell response

PHP2Shell is a pair of PHP core bugs disclosed 2026-10-21. An unauthenticated
request can push a worker into out-of-memory and leave stale state that the next
request on the same worker uses. Impact: remote code execution and worker memory
leaking out through the `PHPSESSID` response cookie. Every PHP from 5.4 through
8.5.11 is affected by at least one of them.

Fixed releases: **8.5.12, 8.4.27, 8.3.36, 8.2.35**. 7.4–8.1 have source
backports only. 5.4–7.3 get nothing.

Exploitation was seen from 2026-10-17. Treat anything exposed since then as
possibly compromised, not only possibly vulnerable.

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

Exit 0 means patched or not affected, 1 means mitigated or unknown, 2 means vulnerable.
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

Apply the interim settings from the PHP advisory, in the web SAPI's config, set
so applications cannot override them (`php_admin_value` in the FPM pool, or the
main `php.ini`, not `.user.ini`):

```ini
memory_limit = -1                  ; CVE-2026-109618
session.upload_progress.enabled = 0 ; CVE-2026-109619
fatal_error_backtraces = 0          ; PHP 8.5 only
```

`memory_limit = -1` removes PHP's own cap, so add a container or cgroup memory
limit at the same time. Restart workers afterwards.

Then put `php2shell-shield` in front of the web server (see the repo README).
It blocks the `PHP_SESSION_UPLOAD_PROGRESS` field, oversized bodies and
excessive multipart parts, and strips malformed `PHPSESSID` cookies on the way
out. Tell the user it is a stopgap that narrows the known vectors. It does not
fix PHP.

If none of this can happen today, CERT-EU and NSA advise taking the service off
the public internet until it can.

### 5. Look for compromise

From 2026-10-17 onward:

- Bursts of HTTP 500 or `Allowed memory size … exhausted` on multipart POSTs
- `PHPSESSID` response cookies containing `%` or longer than 256 chars
- Unexplained PHP worker restarts or crashes
- New or modified `.php` files in web roots and upload dirs:
  `find /var/www -name '*.php' -newermt 2026-10-17`
- Outbound connections from PHP workers

If any of these turn up, say so plainly and recommend incident response:
rotate secrets that were in worker memory (DB passwords, API keys, session
signing keys), invalidate sessions, rebuild from known-good images.

## Rules

- Never claim a system is safe on the basis of mitigations or the shield alone.
- Never run exploit code or proof-of-concept payloads against anything.
- Quote version numbers from this file or the PHP advisory, not from memory.
