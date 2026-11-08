#!/bin/bash
# Installs op-scoped root-owned and read-only into /usr/local/libexec/op-scoped.
# Run in your own Terminal:  sudo tools/op-scoped/install.sh "<1Password vault name>"
# keys.map (your approved key names) is optional; copy keys.map.example to keys.map and fill it first.
# The 1Password Python SDK and its dependencies install from requirements.lock, checked by sha256.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/usr/local/libexec/op-scoped
PYFW="/Library/Frameworks/Python.framework/Versions/3.13"
PY="$PYFW/bin/python3.13"

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
VAULT="${1:-}"
[[ $VAULT =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,63}$ ]] || { echo "Give the 1Password vault name: install.sh \"<vault name>\"" >&2; exit 1; }
[[ -f "$SRC/keys.map" ]] || : > "$SRC/keys.map"
[[ -x $PY ]] || { echo "Install python.org Python 3.13 first." >&2; exit 1; }

# python.org's installer leaves its framework writable by the admin group, which
# includes your account. Lock it to root so no program running as you can change it.
chown -R root:wheel "$PYFW"
chmod -R go-w "$PYFW"

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
xcrun swiftc -O "$SRC/touchid.swift" -o "$BUILD/touchid"
xcrun swiftc -O "$SRC/mask.swift" -o "$BUILD/mask"
"$PY" -I -m pip install --isolated --no-cache-dir --disable-pip-version-check --require-hashes \
  --only-binary=:all: --no-deps --target "$BUILD/pylib" -r "$SRC/requirements.lock"

rm -rf "$DEST"
install -d -o root -g wheel -m 755 /usr/local/libexec "$DEST"
sed "s#^VAULT=\"__VAULT__\".*#VAULT=\"$VAULT\"#" "$SRC/op-scoped" > "$BUILD/op-scoped"
install -o root -g wheel -m 555 "$BUILD/op-scoped" "$DEST/op-scoped"
install -o root -g wheel -m 444 "$SRC/fetch.py" "$DEST/fetch.py"
install -o root -g wheel -m 444 "$SRC/keys.map" "$DEST/keys.map"
install -o root -g wheel -m 555 "$BUILD/touchid" "$DEST/touchid"
install -o root -g wheel -m 555 "$BUILD/mask" "$DEST/mask"
cp -R "$BUILD/pylib" "$DEST/pylib"
# The 1Password CLI as the --cli fallback: a root-owned copy, checked against 1Password's signature.
OP_SRC="$(readlink -f /opt/homebrew/bin/op 2>/dev/null || true)"
REQ='anchor apple generic and certificate leaf[subject.OU] = "2BUA8C4S2C"'
if [[ -n $OP_SRC ]] && codesign --verify --strict -R="$REQ" "$OP_SRC"; then
  install -o root -g wheel -m 555 "$OP_SRC" "$DEST/op"
else
  echo "1Password CLI not found or failed its signature check; --cli fallback not installed." >&2
fi
chown -R root:wheel "$DEST/pylib"
chmod -R go-w,a+rX "$DEST/pylib"
ls -l "$DEST"
echo "Installed. Use: $DEST/op-scoped"
