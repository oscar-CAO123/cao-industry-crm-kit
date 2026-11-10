# Database setup

The CRM shell runs on any Postgres. The business gives it one connection string, `DATABASE_URL`, kept in 1Password
under the name the refs file gives it (`secrets.refs.json`). Nothing else about the database is configured by hand.

## The two strings

- **`DATABASE_URL`** (required): the string the running app and every cron use.
- **`DIRECT_URL`** (required in the refs file, see below): a string that goes straight to the database, not through a
  pooler. Migrations and the Prisma CLI use it. If the host gives only one string, put the same string in both.

Every deploy's refs file lists `DIRECT_URL`. The launcher reads every listed name, so a business with no pooler
stores the same value as `DATABASE_URL` under it.

Why it matters: a transaction pooler (Supabase's pooler on port 6543, PgBouncer in transaction mode) cannot run
migrations. The approval lock does not need a direct string: it is a lease row in `shell_Locks`, so it works through
any pooler.

## SSL

Put `sslmode` in the URL. The shell reads it:

- `require`, `verify-ca`, `verify-full`, or no `sslmode` on a remote host: the connection is encrypted and the server's
  certificate and host name are checked. The shell checks the certificate for every remote host, whatever `sslmode`
  says. `no-verify` and `prefer` are treated the same way.
- `sslmode=disable`: plain text, accepted only for a database on this machine or the compose network (`localhost`,
  `127.0.0.1`, `::1`, `db`). For any other host the shell refuses the connection.
- If the provider's certificate is not in the system's trusted roots, set `DATABASE_CA_CERT` to the provider's CA
  certificate as PEM text. The shell checks the server against it. A CA certificate is public, so it is not a secret.

## Hosts

Every host works the same way. Take the connection string from the host's own connection settings page (see the
host's connection settings page for the exact place). Then:

- `DATABASE_URL`: the pooled string if the host offers one, otherwise the only string.
- `DIRECT_URL`: the direct string if the host offers one, otherwise the same string as `DATABASE_URL`.
- `sslmode=verify-full` in the URL, and `DATABASE_CA_CERT` with the host's CA certificate if the check fails.

**Supabase.** The pooler is on port 6543 (transaction mode). That string goes in `DATABASE_URL`. The direct string goes
in `DIRECT_URL`.

**Firebase (its SQL option, Data Connect).** Data Connect runs on Cloud SQL for PostgreSQL, so use the Cloud SQL
string for the instance (next section).

**Neon, AWS RDS or Aurora PostgreSQL, Azure Database for PostgreSQL, Google Cloud SQL, Railway, Render.** Same rule as
above. Where the host offers a pooler (RDS Proxy, Neon's pooled string, Azure's connection pooling), its string is
`DATABASE_URL`. Everything else is `DIRECT_URL`.

**A plain server.** Use the server's string. For a database on the same machine, `sslmode=disable` on `localhost` is
accepted. Otherwise use `verify-full` and the server's CA certificate.

## Checking the setup

Schema changes apply once the database is set, with the same string the shell uses:

    sh scripts/with-secrets.sh -- node scripts/db-apply.mjs

It uses `DIRECT_URL` when it is set and `DATABASE_URL` otherwise. It prints each file it applies, or that the database is
up to date. Run it before the first sign-in.
