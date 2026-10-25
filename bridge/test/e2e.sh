#!/usr/bin/env bash
# End-to-end: real PHP-FPM behind php-bridge, with one route moved to Node.
set -euo pipefail
cd "$(dirname "$0")/../examples/legacy-app"
export FPM_PORT=${FPM_PORT:-19000} SESSIONS_DIR UID GID
GID=$(id -g)
BRIDGE_PORT=${BRIDGE_PORT:-19080}
tmp=$(mktemp -d); SESSIONS_DIR="$tmp/sessions"; mkdir "$SESSIONS_DIR"
cleanup() { kill "${pid:-0}" 2>/dev/null || true; docker compose down -v >/dev/null 2>&1; rm -rf "$tmp"; }
trap cleanup EXIT

docker compose up -d >/dev/null 2>&1
for _ in $(seq 30); do nc -z 127.0.0.1 "$FPM_PORT" 2>/dev/null && break; sleep 1; done

node ../../bin/php-bridge.js --listen 127.0.0.1:$BRIDGE_PORT --root ./www --fpm-root /var/www/html \
  --fpm 127.0.0.1:$FPM_PORT --front-controller index.php --routes ./routes.mjs \
  --session-path "$SESSIONS_DIR" --stats-path /__stats 2>"$tmp/bridge.log" &
pid=$!
URL=http://127.0.0.1:$BRIDGE_PORT
for _ in $(seq 30); do curl -fs "$URL/style.css" >/dev/null 2>&1 && break; sleep 0.3; done

fail=0
expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want [$2] got [$3]"; fail=1; fi; }
jar="$tmp/jar"; echo hello > "$tmp/up.txt"

expect "php page via front controller" "<h1>Hello, stranger</h1>" "$(curl -s -c "$jar" "$URL/" | grep -o '<h1>[^<]*</h1>')"
expect "static file"                   "body { font-family: sans-serif }" "$(curl -s "$URL/style.css")"
expect "login (PHP) redirects"         302 "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -c "$jar" -d name=hyunho "$URL/login")"
expect "PHP sees the session"          "<h1>Hello, hyunho</h1>" "$(curl -s -b "$jar" "$URL/" | grep -o '<h1>[^<]*</h1>')"
expect "Node route reads PHP session"  '{"servedBy":"node","user":{"name":"hyunho","roles":["member"]}}' "$(curl -s -b "$jar" "$URL/whoami")"
expect "upload reaches PHP"            '{"name":"up.txt","size":6,"error":0}' "$(curl -s -b "$jar" -F file=@"$tmp/up.txt" "$URL/upload")"
expect "PHP source never served"       0 "$(curl -s "$URL/index.php" | grep -c '<?php' || true)"
expect "dotfile refused"               403 "$(curl -s -o /dev/null -w '%{http_code}' "$URL/.htaccess")"
expect "upload-progress blocked"       403 "$(curl -s -o /dev/null -w '%{http_code}' -F PHP_SESSION_UPLOAD_PROGRESS=x -F file=@"$tmp/up.txt" "$URL/upload")"
stats=$(curl -s "$URL/__stats")
expect "stats count node route"        1 "$(echo "$stats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).node["GET /whoami"]))')"
expect "stats count php script"        true "$(echo "$stats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).php["/index.php"]>=4))')"

[ $fail = 0 ] || { echo "--- bridge log"; cat "$tmp/bridge.log"; }
exit $fail
