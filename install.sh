#!/bin/sh
# Install php2shell-shield and php2shell-check from GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/imhyunho99/php2shell-shield/main/install.sh | sh
#
# Env: VERSION (default: latest), PREFIX (default: /usr/local/bin)
set -eu

REPO=imhyunho99/php2shell-shield
PREFIX=${PREFIX:-/usr/local/bin}

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in linux|darwin) ;; *) echo "unsupported OS: $os" >&2; exit 1 ;; esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

if [ -z "${VERSION:-}" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
fi
[ -n "$VERSION" ] || { echo "could not find the latest release" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/$REPO/releases/download/$VERSION"

curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
for cmd in php2shell-shield php2shell-check; do
  f="${cmd}_${os}_${arch}"
  curl -fsSL -o "$tmp/$f" "$base/$f"
  want=$(grep " $f\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
  if command -v sha256sum >/dev/null; then got=$(sha256sum "$tmp/$f" | cut -d' ' -f1)
  else got=$(shasum -a 256 "$tmp/$f" | cut -d' ' -f1); fi
  [ -n "$want" ] && [ "$want" = "$got" ] || { echo "checksum mismatch for $f" >&2; exit 1; }
  chmod +x "$tmp/$f"
done

sudo=""
if [ ! -w "$PREFIX" ] && [ "$(id -u)" != 0 ]; then sudo="sudo"; fi
$sudo mkdir -p "$PREFIX"
for cmd in php2shell-shield php2shell-check; do
  $sudo mv "$tmp/${cmd}_${os}_${arch}" "$PREFIX/$cmd"
done

echo "installed $VERSION to $PREFIX"
echo "next: php2shell-check -php php-fpm   (or: php -i | php2shell-check -stdin)"
