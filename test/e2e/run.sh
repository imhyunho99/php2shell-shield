#!/usr/bin/env bash
# End-to-end: real PHP behind the shield. Requires docker compose.
set -euo pipefail
cd "$(dirname "$0")"
URL=http://127.0.0.1:${E2E_PORT:-18480}
tmp=$(mktemp -d)
trap 'docker compose down -v >/dev/null 2>&1; rm -rf "$tmp"' EXIT

docker compose up -d --build --wait >/dev/null 2>&1 || docker compose up -d --build >/dev/null
for _ in $(seq 30); do curl -fs "$URL/" >/dev/null 2>&1 && break; sleep 1; done

fail=0
expect() { # name want got
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want $2, got $3"; fail=1; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo hello > "$tmp/up.txt"
jar="$tmp/jar"

expect "plain GET passes"        200 "$(code -c "$jar" "$URL/")"
expect "session persists"        "visits=2" "$(curl -s -b "$jar" "$URL/" | head -1)"
expect "normal upload reaches PHP" "file f 6" "$(curl -s -b "$jar" -F t=x -F f=@"$tmp/up.txt" "$URL/" | grep '^file')"
expect "upload-progress blocked" 403 "$(code -F PHP_SESSION_UPLOAD_PROGRESS=x -F f=@"$tmp/up.txt" "$URL/")"
expect "oversized body blocked"  413 "$(head -c 20000000 /dev/zero | code --data-binary @- "$URL/")"
args=(); for i in $(seq 1100); do args+=(-F "a$i=1"); done
expect "too many parts blocked"  413 "$(code "${args[@]}" "$URL/")"
hdrs="$tmp/hdrs"
{ printf -- '--b\r\nContent-Disposition: form-data; name=a\r\n'; for i in $(seq 50); do printf 'X-%d: v\r\n' "$i"; done; printf '\r\nx\r\n--b--\r\n'; } > "$hdrs"
expect "part header amplification blocked" 431 "$(code -H 'Content-Type: multipart/form-data; boundary=b' --data-binary @"$hdrs" "$URL/")"
expect "deep field nesting blocked" 400 "$(code -F 'a[1][2][3][4][5][6][7][8][9][10]=x' "$URL/")"
expect "nested form fields pass"    200 "$(code -F 'user[address][city]=x' -F 'tags[]=y' "$URL/")"
expect "leaking cookie stripped" 0 "$(curl -s -D - -o /dev/null "$URL/leak.php" | grep -ci '^set-cookie: phpsessid' || true)"
expect "leak was logged"         1 "$(docker compose logs shield 2>/dev/null | grep -c session-cookie-leak || true)"

exit $fail
