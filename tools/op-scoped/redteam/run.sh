#!/bin/bash
# Red-teams op-scoped with FAKE credentials only. Never touches the real Keychain item,
# the real vault, or the installed copy in /usr/local/libexec/op-scoped.
#   tools/op-scoped/redteam/run.sh
# Builds a throwaway bench (fake token in Keychain item op-scoped-redteam, stand-ins for
# Touch ID, the fetcher and op, plus the real pinned SDK and the real op binary), then runs
# the head-to-head and the full suite in both modes, then removes the bench.
# Run it outside any sandbox: the process-visibility tests need the real ps view.
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
PY=/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13
B="$(mktemp -d)"
cleanup() {
  /usr/bin/security delete-generic-password -a "$USER" -s op-scoped-redteam >/dev/null 2>&1
  /usr/bin/pkill -U "$(id -u)" -f "op daemon" 2>/dev/null
  rm -rf "$B"
}
trap cleanup EXIT

mkdir -p "$B/inst" "$B/real" "$B/evil"
cp "$SRC/redteam/tests.sh" "$SRC/redteam/compare.sh" "$B/"
swiftc -O "$SRC/mask.swift" -o "$B/inst/mask" && cp "$B/inst/mask" "$B/real/mask"
"$PY" -I -m pip install --isolated --no-cache-dir --disable-pip-version-check -q --require-hashes \
  --only-binary=:all: --no-deps --target "$B/real/pylib" -r "$SRC/requirements.lock"
sed "s#^PYLIB = .*#PYLIB = \"$B/real/pylib\"#" "$SRC/fetch.py" > "$B/real/fetch.py"
cp "$(readlink -f /opt/homebrew/bin/op)" "$B/real/op"

# Stand-in fetcher (SDK mode): logs what it received, optionally lingers 2s for the watchers.
cat > "$B/inst/fetch.py" <<EOF
import os, sys, time
d = sys.stdin.read().split("\n"); tok, refs = d[0], [r for r in d[1:] if r]
with open("$B/log", "a") as f:
    f.write("fetch ran\n"); f.write("fetch env: " + " ".join(sorted(os.environ)) + "\n")
    if tok.startswith("FAKE-TOKEN"): f.write("fetch got token\n")
if os.path.exists("$B/slow"): time.sleep(2)
if refs == ["vault-list"]: print("fake  Business Vault"); sys.exit(0)
if refs == ["item-names"]: print("op://Business Vault/fake-item/credential"); sys.exit(0)
for r in refs:
    if r != "op://Business Vault/fake-item/credential": sys.exit(1)
    sys.stdout.write("FAKE-SECRET-VALUE-9f3k\0")
sys.stdout.write("OK\0")
EOF
# Stand-in op (--cli mode).
cat > "$B/inst/op" <<EOF
#!/bin/bash
echo "fetch ran" >> "$B/log"; echo "fetch env: \$(env | cut -d= -f1 | grep -v '^_$\|^PWD$\|^SHLVL$\|^OLDPWD$' | sort | tr '\n' ' ')" >> "$B/log"
[[ "\${OP_SERVICE_ACCOUNT_TOKEN:-}" == FAKE-TOKEN-* ]] && echo "fetch got token" >> "$B/log"
[[ -f "$B/slow" ]] && sleep 2
case "\$*" in
  *"vault list"*) echo "fake  Business Vault" ;;
  *"read --no-newline op://Business Vault/fake-item/credential") printf 'FAKE-SECRET-VALUE-9f3k' ;;
  *) exit 1 ;;
esac
EOF
# Stand-in Touch ID: logs the text it would show; denies when $B/deny exists.
for t in inst real; do cat > "$B/$t/touchid" <<EOF
#!/bin/bash
echo "touchid asked: \$1" >> "$B/log"
[[ -f "$B/deny" ]] && exit 1
exit 0
EOF
done
chmod +x "$B/inst/op" "$B/inst/touchid" "$B/real/touchid"

for t in inst real; do printf '# test map\nFAKE_KEY=op://Business Vault/fake-item/credential\nOUTSIDE_KEY=op://Private/x/y\n' > "$B/$t/keys.map"; done
mk() { sed -e "s#^VAULT=.*#VAULT=\"Business Vault\"#" -e "s#^DIR=.*#DIR=\"$2\"#" -e 's#^SERVICE=.*#SERVICE="op-scoped-redteam"#' -e "s#^REQUIRE_ROOT=1#REQUIRE_ROOT=$3#" "$SRC/op-scoped" > "$1"; chmod +x "$1"; }
mk "$B/op-scoped-test" "$B/inst" 0; mk "$B/op-scoped-root" "$B/inst" 1; mk "$B/op-scoped-real" "$B/real" 0
/usr/bin/security add-generic-password -U -a "$USER" -s op-scoped-redteam -w FAKE-TOKEN-7731 -T /usr/bin/security

echo "######## HEAD TO HEAD (real binaries, fake token)"; "$B/compare.sh"
echo; echo "######## SUITE: Python library (default)"; "$B/tests.sh"
echo; echo "######## SUITE: --cli fallback (T4 fails by design: op needs the token in its environment)"; "$B/tests.sh" --cli
/usr/bin/pkill -U "$(id -u)" -f "op daemon" 2>/dev/null
left=0
for i in 1 2 3; do "$B/op-scoped-real" --cli run KEY="op://Business Vault/fake-item/credential" -- /usr/bin/true >/dev/null 2>&1; sleep 1.5
  left=$((left + $(pgrep -f 'op daemon' | wc -l | tr -d ' '))); /usr/bin/pkill -U "$(id -u)" -f "op daemon" 2>/dev/null; done
echo; echo "real --cli runs: 3, op daemons left behind: $left"
