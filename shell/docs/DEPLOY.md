# Deploy anywhere

One image (`Dockerfile`, built from the kit root) runs the web app, every workflow cron and the schema tool. Only
the scheduler and the place the one 1Password token lives change between hosts.

```
node tools/shell-deploy.ts <target> <out-dir> <industry> [industry ...]
```
Targets: `docker`, `server`, `railway`, `aws` (ECS + EventBridge Scheduler), `gcp` (Cloud Run + Jobs + Scheduler),
`azure` (Container Apps + Jobs), `vercel` (Vercel Cron), `supabase` (pg_cron, token in Supabase Vault),
`cloudflare` (Cron Trigger worker), `netlify` (scheduled functions). It writes key names and `op://` placeholders,
never a value.

## Order
1. Create the database (any Postgres) and the vault; add every key from `secrets.refs.json.example`.
2. `node scripts/with-secrets.mjs -- node scripts/db-apply.mjs` applies `db/` in order.
3. Start the web app. The first person to sign in becomes admin. Admin, Templates: apply the industry.
4. Fill `settings/<workflow>.json` for each workflow switched on, then schedule its crons with the target's files.
5. Set `KIT_ALLOW_WRITES=1` only when the business is ready for approved acts to run.

Every change after that: a pull request, checks green, then the host redeploys the image.
