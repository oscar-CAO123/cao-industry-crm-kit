# Security

What the shell does, and the checklist every change passes. Mapped to OWASP Top 10 2025, OWASP ASVS 5.0, the OWASP
LLM Top 10 2025 and CIS Controls v8.1.

## In place
- **Access control (A01, ASVS V8):** pages need an active session, checked in `proxy.ts` before render; every server
  action and API route checks again (`lib/auth-server.ts`); writes need the admin or member role; templates need admin.
  Pending and deactivated users are treated as signed out everywhere.
- **Sign-in (ASVS V6, V7):** email code or Google, sign-up limited to the business's domains (`AUTH_SIGNUP_DOMAINS`),
  the first user becomes admin and everyone after waits for approval. Seven-day sessions. Google tokens are encrypted.
- **Headers (ASVS V3):** a per-request nonce Content-Security-Policy, HSTS, `X-Frame-Options: DENY`, `nosniff`,
  a strict referrer policy and a closed permissions policy on every response. The app is never indexed.
- **Input (ASVS V2):** template and record data is validated against the page's own field list; unknown fields are
  dropped; template files are schema-checked before use.
- **Secrets (A02, A03):** see `CREDENTIALS.md`. Nothing in plain text, one vault, a launcher that keeps the token away from the service and never lets a key problem stop it.
- **Data:** Postgres over verified TLS on any provider (`lib/db-ssl.ts`), additive-only schema changes
  (`scripts/db-apply.mjs`), soft deletes, an audit log of every change, template apply and approval decision.
- **Outbound actions (LLM06 excessive agency):** nothing reaches outside without the approval click (`APPROVALS.md`).
- **Mail:** the CRM mails only its own users. Customer mail is a workflow act, approved first.
- **Scheduler trigger:** one route, a 32+ character bearer token compared in constant time, enabled workflows and
  declared crons only, one run at a time.

## Checklist for every change
- [ ] New server action or route: active session, role for writes, input validated, only needed fields returned.
- [ ] No `process.env` read of a key outside the launcher's list; no key, token or `.env` value in the diff.
- [ ] No outside call from the web app; outside calls are workflow acts through the SDK gate.
- [ ] Anything outside text touches is treated as data; model output is validated before a write.
- [ ] Schema change is a new additive file in `db/`.
- [ ] New dependency reviewed (repository, maintainers, release age, install scripts) before it is added.
- [ ] `pnpm typecheck`, `pnpm test`, the kit's `node --test tests/shell.test.ts` and a secret scan pass.

## Owner's duties
Name a security owner. Keep the vault's access list current and rotate on departures. Back up the database and
rehearse a restore. Write down the incident and breach-notification path for the business's jurisdiction.

## Known limits (pen test of 10 Nov 2026)

- **The 1Password service token reaches the container as an environment variable.** Anyone who can run `docker inspect` on the host (the docker group, root) can read it, and it opens the whole business vault. That is the same reach as root on the host, but keep the vault to this business's keys only, give the token read access only, and rotate it when anyone with host access leaves. Only a secret mounted as a file (a Docker secret, a Kubernetes secret volume) stays out of the container's environment; platform variables such as Railway's are still environment. Launcher: `shell/scripts/with-secrets.sh` drops the token before the service starts.
- **The base images are tags, not digests.** Pin `node:22.18-slim` and `postgres:17-alpine` by digest at the first real deploy, after checking them on the registry.
- **`better-auth` rate limits and cookie flags** are set in `lib/auth.ts` but were never run against a live server. Check them on the first shell run.
