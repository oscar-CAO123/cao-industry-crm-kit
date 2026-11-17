# Credentials

Every key lives in the business's one 1Password vault. Nothing is kept in plain text: not in the repo, not in an
env file, not in the host's settings.

## On the operator's laptop
- Keys reach a command through `tools/op-scoped` (see its README). Each run asks for Touch ID, then the Mac password,
  and starts the command with only the named keys.
- `keys.map` is the approved list. Only references on it are ever read; anything else in the vault is refused.
- The agent (Claude Code, Codex) asks for a key by name. It never reads the Keychain item, never prints a key and
  never writes one to a file.

## On a deploy
- The host holds one secret: the token of a read-only 1Password service account for the business's vault, plus
  `SHELL_VAULT`, the vault's name. Where the platform allows it, the token is a mounted file, not a variable.
- `shell/scripts/with-secrets.sh` starts the web app, the approval runner and every cron. It reads the keys listed
  in `secrets.refs.json` (names and `op://` references only), drops the token and replaces itself with the command.
- `node tools/shell-deploy.ts` writes `secrets.refs.json.example` with every key name the switched-on workflows need.

## Saved sign-in tokens
- Rotating tokens (Xero, Google and Bullhorn refresh tokens) are saved by the connectors in a token folder
  (`KIT_TOKEN_DIR`, default `~/.kit-tokens`), owner-only, each file encrypted with AES-256-GCM.
- The key is `KIT_TOKEN_KEY`: a random value of 32 or more characters, kept in the vault like any other key. Without
  it no token is read or written, and a plain-text or swapped file is never trusted. Xero and Bullhorn check the key
  before spending a single-use refresh token. A token saved before encryption was added reads as missing: connect
  that app once more.

## Writes and approvals
- `KIT_ALLOW_WRITES=1` is the deploy's master switch. Generated deploy files start with it at 0. It opens nothing by
  itself: a write also needs one of the kit's entry points (a cron, limited to draft operations that reach nobody
  outside the business; the CRM's signed approval click; or a person confirming at the terminal). See `APPROVALS.md`.
- The approval click is signed with a key derived from `BETTER_AUTH_SECRET`, so keep that secret 32 characters or more.
