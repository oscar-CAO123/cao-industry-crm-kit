# op-scoped: keys from 1Password for one command, behind Touch ID

The placed operator's laptop helper. Every key the operator's agent (Claude Code, Codex) uses comes from the
business's one 1Password vault through this helper, never from a file. Nothing is stored in plain text.

```
/usr/local/libexec/op-scoped/op-scoped run API_KEY="op://<vault>/<item>/<field>" -- <command> [args]
/usr/local/libexec/op-scoped/op-scoped run XERO_CLIENT_ID -- <command>      (a name from keys.map)
/usr/local/libexec/op-scoped/op-scoped vault list
```

- Each run asks for **Touch ID** (the box shows the exact command and key names), then the **Mac password** for
  the Keychain item that holds the service account token. Deny any password box that comes without a Touch ID box.
- The command starts with a clean environment plus the named keys only, and its output is masked.
- References outside the installed vault are refused. A bare name not in `keys.map` is refused.

## Set up (once per laptop)

1. In 1Password, the business owner creates a vault for the business and a **read-only service account** for it.
2. Install python.org Python 3.13, then put the service account token in the login Keychain yourself, in Terminal
   (the token never goes in a file): `security add-generic-password -a "$USER" -s op-service-account -w`
3. Optional: copy `keys.map.example` to `keys.map` and list the approved key names.
4. `sudo tools/op-scoped/install.sh "<vault name>"` installs it root-owned and read-only.
5. Check: `/usr/local/libexec/op-scoped/op-scoped vault list` shows only the business's vault.

## Never

- Print, transform or write a key value to a file. Never put the service account token in an env file.
- Run the 1Password CLI with a token outside this helper (`--cli` is the weaker fallback; it kills `op daemon` on exit).
- Edit the Keychain item in Keychain Access (it adds a second password box on every run).

## Change it

Edit the source here, run `redteam/run.sh` (fake credentials only; expect 0 fails in SDK mode and only T4 in `--cli`
mode), then reinstall. To bump a pinned package in `requirements.lock`, security-sweep the new release first.
The deployed CRM uses the same vault through `shell/scripts/with-secrets.mjs`; see `shell/docs/CREDENTIALS.md`.
