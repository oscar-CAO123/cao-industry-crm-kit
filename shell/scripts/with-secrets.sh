#!/bin/sh
# Start a command with its keys read from 1Password. The deployed CRM, its approval runner and every cron start
# through this, so no key is ever stored in plain text: not in the repo, not in an env file, not in the host's settings.
#
#   sh shell/scripts/with-secrets.sh -- node shell/server.js
#
# The host holds exactly one secret, OP_SERVICE_ACCOUNT_TOKEN (a read-only 1Password service account for the
# business's own vault; SHELL_OP_TOKEN is the same thing under a name op-scoped may set on a laptop), plus
# SHELL_VAULT, the vault's name.
#
# How it works, and why it is a shell script:
# - A short-lived child (node with-secrets.mjs --print) reads the keys and prints each as NAME plus its value in
#   base64, then exits. This script decodes each value straight into its variable. There is no eval, so nothing a
#   value contains can ever be read as shell code, and no value is written to a file.
# - It then drops the token and REPLACES ITSELF with the command (exec). No process is left running that holds the
#   token. A launcher that stayed alive as the service's parent would keep the token in its start-up environment,
#   which any process of the same user (the service, a cron, a script an agent wrote) can read, and the token opens
#   the whole vault, not just the keys listed.
# - A mapped name is always cleared first (the resolver's --names step needs no token), so an old host copy can never
#   stand in for a missing key, even when the keys cannot be loaded at all.
# - A problem never stops the service. If the keys cannot be loaded, or one of them cannot be read, the service
#   starts with a warning that names what is missing (never a value), so only the feature that needs it fails.
# - A name that changes how a shell, the dynamic loader or Node run code is never set from a vault value, even if
#   the resolver printed it. The resolver filters these too; this is the second check.
IFS='
'
NL='
'
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "${1:-}" = "--" ]; then shift; fi
if [ $# -eq 0 ]; then echo "[secrets] usage: sh with-secrets.sh -- <command> [args]" >&2; exit 2; fi

warn() { echo "==> 1Password: $1" >&2; }

blocked_name() {
  case "$1" in
    PATH | IFS | ENV | BASH_ENV | HOME | SHELL | PS4 | CDPATH | TMPDIR | GCONV_PATH | GLIBC_TUNABLES | LOCPATH | NLSPATH | HOSTALIASES | \
    BASHOPTS | SHELLOPTS | BROWSER | EDITOR | VISUAL | PAGER | ZDOTDIR | \
    NODE_* | NPM_* | YARN_* | PNPM_* | BUN_* | DENO_* | SSL_* | OPENSSL_* | *_PROXY | *_proxy | PYTHON* | LD_* | DYLD_* | OP_* | BASH_FUNC_* | MALLOC_* | \
    GIT_* | PERL* | RUBY* | JAVA_* | GEM_* | PIP_* | COREPACK_* | CURL_* | XDG_* | ELECTRON_* ) return 0 ;;
    *) return 1 ;;
  esac
}

valid_name() {
  case "$1" in "" | *[!A-Z0-9_]*) return 1 ;; esac
  case "$1" in [A-Z]*) ;; *) return 1 ;; esac
  blocked_name "$1" && return 1
  return 0
}

# A mapped name is cleared first, whatever happens next, so a host copy can never stand in for a missing key.
clear_mapped() {
  names=$(node "$HERE/with-secrets.mjs" --names </dev/null 2>/dev/null) || return 0
  rest=$names
  while [ -n "$rest" ]; do
    name=${rest%%"$NL"*}
    case "$rest" in *"$NL"*) rest=${rest#*"$NL"} ;; *) rest= ;; esac
    if valid_name "$name"; then unset "$name"; fi
  done
}

load_secrets() {
  token="${OP_SERVICE_ACCOUNT_TOKEN:-${SHELL_OP_TOKEN:-}}"
  if [ -z "$token" ]; then warn "OP_SERVICE_ACCOUNT_TOKEN missing; starting without 1Password keys"; return; fi
  if ! command -v base64 >/dev/null 2>&1; then warn "base64 not found; starting without 1Password keys"; return; fi
  if ! out=$(OP_SERVICE_ACCOUNT_TOKEN="$token" node "$HERE/with-secrets.mjs" --print </dev/null); then
    warn "the keys could not be loaded; starting without 1Password keys"
    return
  fi
  rest=$out
  while [ -n "$rest" ]; do
    line=${rest%%"$NL"*}
    case "$rest" in *"$NL"*) rest=${rest#*"$NL"} ;; *) rest= ;; esac
    kind=${line%% *}; line=${line#* }
    name=${line%% *}; b64=${line#* }
    [ "$b64" = "$line" ] && b64=
    valid_name "$name" || continue
    case "$kind" in
      V)
        # "x" is added only after a clean decode and removed again, so the shell keeps any trailing newline (a PEM key
        # ends with one) and a failed decode never leaves a partial value behind.
        if value=$(printf '%s' "$b64" | base64 -d 2>/dev/null && printf x); then
          value=${value%x}
          if [ -n "$value" ]; then export "$name=$value"; else unset "$name"; fi
        else
          unset "$name"
        fi ;;
      M) unset "$name" ;;
    esac
  done
}

clear_mapped
load_secrets
unset token out names rest line kind name b64 value OP_SERVICE_ACCOUNT_TOKEN SHELL_OP_TOKEN
exec "$@"
