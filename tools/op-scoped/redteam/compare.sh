#!/bin/bash
# Real binaries, fake token: can another program read the token while each fetcher works?
S="$(cd "$(dirname "$0")" && pwd)"; PY=/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13
watch() { for i in $(seq 1 30); do ps eww -ax 2>/dev/null | grep -q "FAKE[-]TOKEN[-]5150" && { echo "VISIBLE"; return; }; sleep 0.05; done; echo "never seen"; }
# 1Password Python library: token goes in on stdin; keep stdin open 2s so the process stays alive.
{ printf 'FAKE-TOKEN-5150\nop://Business Vault/x/y\n'; sleep 2; } | /usr/bin/env -i HOME="$HOME" "$PY" -I "$S/real/fetch.py" >/dev/null 2>"$S/sdk.err" & p=$!
echo "SDK  (real library): token $(watch) to other programs | its error: $(cat "$S/sdk.err" 2>/dev/null | head -1)"; wait $p 2>/dev/null
# 1Password CLI: token goes in through the environment; op inject waits on stdin, so it stays alive.
{ sleep 2; printf 'x={{ op://Business Vault/x/y }}\n'; } | /usr/bin/env -i HOME="$HOME" OP_CACHE=false OP_SERVICE_ACCOUNT_TOKEN=FAKE-TOKEN-5150 "$S/real/op" --cache=false inject >/dev/null 2>&1 & q=$!
echo "CLI  (real op):      token $(watch) to other programs"; wait $q 2>/dev/null
