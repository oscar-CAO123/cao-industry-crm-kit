#!/bin/bash
S="$(cd "$(dirname "$0")" && pwd)"; V="${1:-}"; H() { "$S/op-scoped-test" $V "$@"; }
REF="op://Business Vault/fake-item/credential"; SECRET="FAKE-SECRET-VALUE-9f3k"; TOKEN="FAKE-TOKEN-7731"
pass=0; fail=0; resid=0
reset() { rm -f "$S/log" "$S/deny" "$S/marker" "$S/slow"; }
ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1"; fail=$((fail+1)); }
res()  { echo "RISK  $1"; resid=$((resid+1)); }
asked(){ grep -q "touchid asked" "$S/log" 2>/dev/null; }
ran()  { grep -q "fetch ran" "$S/log" 2>/dev/null; }

reset; out=$(H run KEY="$REF" -- /bin/sh -c 'echo "got:$KEY"'); rc=$?
[[ $rc == 0 && $out == "got:<concealed by op-scoped>" ]] && asked && ran && grep -q "fetch got token" "$S/log" && ok "T1 happy path: token reaches the fetcher, key reaches the command, output masked" || bad "T1 rc=$rc out=$out"
reset; out=$(H run KEY="$REF" -- /usr/bin/env); [[ $out != *FAKE[-]TOKEN* && $out != *OP_* ]] && ok "T2 command's environment has no token" || bad "T2"
reset; out=$(OP_SERVICE_ACCOUNT_TOKEN=callerset SOMEVAR=x H run KEY="$REF" -- /usr/bin/env); [[ $out != *OP_* && $out != *SOMEVAR* ]] && ok "T3 caller environment never reaches the command" || bad "T3"
reset; H run KEY="$REF" -- /usr/bin/true >/dev/null; e=$(grep "fetch env:" "$S/log" | sed 's/fetch env: //'); [[ $e =~ ^(HOME|LC_CTYPE|__CF_USER_TEXT_ENCODING| )*$ ]] && ok "T4 fetcher runs with an empty environment ($e)" || bad "T4 fetcher env: $e"
reset; touch "$S/slow"; ( for i in $(seq 1 40); do ps eww -ax 2>/dev/null | grep -q "FAKE[-]TOKEN[-]7731" && { echo seen > "$S/marker"; break; }; sleep 0.05; done ) & w=$!
H run KEY="$REF" -- /usr/bin/true >/dev/null; wait $w; grep -q "fetch got token" "$S/log" || bad "T5 setup: fetcher never got the token"
[[ ! -f "$S/marker" ]] && ok "T5 token never visible in any process's command line or environment while fetching" || bad "T5 token visible to another program"
reset; touch "$S/slow"; ( for i in $(seq 1 40); do ps eww -ax 2>/dev/null | grep -q "FAKE[-]SECRET[-]VALUE" && { echo seen > "$S/marker"; break; }; sleep 0.05; done ) & w=$!
H run KEY="$REF" -- /bin/sleep 1 >/dev/null; wait $w
[[ -f "$S/marker" ]] && res "T5b the key itself sits in the command's environment while it runs; other programs can read it if the command is not an Apple program" || ok "T5b key not visible while the command runs (Apple program)"
reset; out=$(H run KEY="$REF" -- /bin/sh -c 'printf %s "$KEY" | base64; echo'); [[ $out != *$SECRET* && $out != *$(printf %s "$SECRET" | base64)* ]] && ok "T6a base64 of key masked" || bad "T6a"
reset; out=$(H run KEY="$REF" -- /bin/sh -c 'printf %s "$KEY" | rev'); [[ $out == *$(printf %s "$SECRET" | rev)* ]] && res "T6b a reversed key is not masked" || ok "T6b reversed masked"
reset; out=$(H run KEY="$REF" -- /bin/sh -c 'printf %s "$KEY" >&2'); [[ $out != *$SECRET* ]] && ok "T6c key on stderr masked" || bad "T6c"
reset; touch "$S/deny"; out=$(H run KEY="$REF" -- /bin/sh -c 'echo ran' 2>&1); rc=$?; [[ $rc == 1 && $out != *ran* ]] && ! ran && ok "T7 Touch ID denied: no Keychain, no fetch, command never runs" || bad "T7 rc=$rc"
for c in "run OP_X=$REF -- true" "run PATH=/x KEY=$REF -- true" "run DYLD_INSERT_LIBRARIES=/x KEY=$REF -- true" "run KEY=$REF true" "run lower=$REF -- true" "read $REF" "item get x" "vault list --format json" "vault get x" "--debug run -- true" "whoami" ""; do
  reset; H $c >/dev/null 2>&1; rc=$?; [[ $rc == 64 ]] && ! asked && ok "T8 blocked: op-scoped $c" || bad "T8 allowed: op-scoped $c (rc=$rc)"; done
reset; H run KEY="op://Private/x/y" -- true 2>/dev/null; [[ $? == 64 ]] && ! asked && ok "T9 ref outside Business Vault refused" || bad "T9"
reset; H run KEY="op://Business Vault/../Private/x" -- true 2>/dev/null; [[ $? == 64 ]] && ok "T9b .. in a ref refused" || bad "T9b"
reset; H run KEY=$'op://Business Vault/a\nop://Private/b' -- true 2>/dev/null; rc=$?; ! ran && ok "T9c newline smuggling a second ref refused (rc=$rc)" || bad "T9c a newline ref reached the fetcher"
reset; KEY="$REF" H run -- true 2>/dev/null; [[ $? == 64 ]] && ok "T11 ref set in the caller environment ignored" || bad "T11"
reset; H run KEY="$REF" -- echo $'a\nb' >/dev/null 2>&1; grep -q "touchid asked: .*\$'a\\\\nb'" "$S/log" && ok "T12 control characters shown escaped on the Touch ID box" || bad "T12"
reset; H run KEY="$REF" -- echo "$(printf 'x%.0s' {1..300})" 2>/dev/null; [[ $? == 64 ]] && ! asked && ok "T13 command too long to show refused" || bad "T13"
reset; for b in security python3 touchid id stat ls grep mask sh env dscl sed getconf; do printf '#!/bin/sh\necho %s > "%s/marker"\n' "$b" "$S" > "$S/evil/$b"; chmod +x "$S/evil/$b"; done
PATH="$S/evil:$PATH" H run KEY="$REF" -- /usr/bin/true >/dev/null 2>&1; [[ ! -f "$S/marker" ]] && ok "T14 PATH hijack ignored" || bad "T14 $(cat "$S/marker")"
reset; printf 'echo x > "%s/marker"\n' "$S" > "$S/evil/bashenv"; BASH_ENV="$S/evil/bashenv" ENV="$S/evil/bashenv" H run KEY="$REF" -- /usr/bin/true >/dev/null 2>&1; [[ ! -f "$S/marker" ]] && ok "T15 BASH_ENV / ENV injection ignored" || bad "T15"
reset; env "BASH_FUNC_printf%%=() { echo f > $S/marker; }" "BASH_FUNC_compgen%%=() { echo f > $S/marker; }" "$S/op-scoped-test" $V run KEY="$REF" -- /usr/bin/true >/dev/null 2>&1; [[ ! -f "$S/marker" ]] && ok "T16 exported function override ignored" || bad "T16"
reset; out=$(/usr/bin/env SHELLOPTS=xtrace PS4='+TRACE ' PYTHONSTARTUP=x PYTHONPATH="$S/evil" PYTHONINSPECT=1 "$S/op-scoped-test" $V run KEY="$REF" -- /usr/bin/true 2>&1); [[ $out != *FAKE[-]TOKEN* && $out != *TRACE* ]] && ok "T17 xtrace and PYTHON* variables cannot reach in" || bad "T17"
reset; H run KEY="$REF" -- /bin/sh -c 'exit 7' >/dev/null; [[ $? == 7 ]] && ok "T19 exit code passed through" || bad "T19"
reset; out=$("$S/op-scoped-root" $V run KEY="$REF" -- /usr/bin/true 2>&1); rc=$?; [[ $rc == 1 ]] && ! asked && ok "T20 files not owned by root refused before Touch ID" || bad "T20 rc=$rc $out"
reset; H run KEY="$REF" -- /bin/sh -c "printf %s \"\$KEY\" > $S/marker" >/dev/null; grep -q "$SECRET" "$S/marker" 2>/dev/null && res "T21 a command can write the key to a file, which masking cannot see" || ok "T21"
reset; H run KEY="$REF" PLAIN_FLAG=1 -- /bin/sh -c 'echo "flag=$PLAIN_FLAG"' | grep -q "flag=1" && ok "T22 plain NAME=value reaches the command" || bad "T22"
reset; out=$(H vault list); [[ $out == *"Business Vault"* ]] && ok "T23 vault list works" || bad "T23"
reset; out=$("$S/op-scoped-real" $V run KEY="$REF" -- /bin/sh -c 'echo ran' 2>&1); rc=$?
[[ $rc == 1 && $out != *ran* && $out != *FAKE[-]TOKEN* && $out != *Traceback* ]] && ok "T24 real 1Password library with a fake token fails cleanly, prints no token ($out)" || bad "T24 rc=$rc out=$out"
if [[ -z $V ]]; then
  reset; out=$(H items); [[ $out == "op://Business Vault/fake-item/credential" ]] && grep -q "touchid asked: op-scoped list item and field names (no values)" "$S/log" && ok "T26 items lists names only, behind Touch ID" || bad "T26 items: $out"
else
  reset; H items >/dev/null 2>&1; [[ $? == 64 ]] && ! asked && ok "T26 items refused in --cli mode" || bad "T26 --cli items allowed"
fi
reset; out=$(H run FAKE_KEY -- /bin/sh -c 'echo "got:$FAKE_KEY"'); [[ $out == "got:<concealed by op-scoped>" ]] && grep -q "keys: FAKE_KEY" "$S/log" && ok "T28 bare key name resolves from the key map" || bad "T28 out=$out"
reset; H run NOT_IN_MAP -- /usr/bin/true >/dev/null 2>&1; [[ $? == 64 ]] && ! asked && ok "T29 name not in the key map refused before Touch ID" || bad "T29"
reset; H run OUTSIDE_KEY -- /usr/bin/true >/dev/null 2>&1; [[ $? == 64 ]] && ! asked && ok "T30 a map entry pointing outside the vault is still refused" || bad "T30"
reset; H run "FAKE_KEY;id" -- /usr/bin/true >/dev/null 2>&1; [[ $? == 64 ]] && ! asked && ok "T31 malformed key name refused" || bad "T31"
for c in "items x" "items --format json"; do reset; H $c >/dev/null 2>&1; rc=$?; [[ $rc == 64 ]] && ! asked && ok "T27 blocked: op-scoped $c" || bad "T27 allowed: op-scoped $c (rc=$rc)"; done
reset; security delete-generic-password -a "$USER" -s op-scoped-redteam >/dev/null 2>&1
H run KEY="$REF" -- /bin/sh -c 'echo ran' >/dev/null 2>&1; rc=$?; [[ $rc == 1 ]] && ! ran && ok "T25 missing Keychain item stops before fetching" || bad "T25 rc=$rc"
security add-generic-password -U -a "$USER" -s op-scoped-redteam -w "$TOKEN" -T /usr/bin/security
echo; echo "passed $pass, failed $fail, known risks $resid"
