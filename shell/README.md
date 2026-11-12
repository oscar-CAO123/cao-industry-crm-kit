# CRM shell

A bare CRM for a small business, run by the operator placed with it. Departments are the navigation; an industry
template switches on that industry's pages and workflows; the workflows read and draft on their own and wait for one
click before anything reaches a customer, moves money or changes a live record.

- Frame: Next.js, Prisma, Postgres, better-auth. Pages: `app/[locale]/(routes)/d/[department]`, Approvals, Admin.
- Templates: `../industries/<industry>/crm-shell/template.json`. Workflows: `../industries/*/workflows/`.
- Rules: `AGENTS.md`. Docs: `docs/`.

```
pnpm typecheck && pnpm test            # no keys, no database
node scripts/db-apply.mjs --check      # schema files obey the additive rule
```

Derived from NextCRM, copyright (c) 2023 Pavel Dovhomilja, MIT licence (`LICENSE`).

## Dependency security patch

Use `pnpm install --frozen-lockfile` so the pinned dependency overrides and `patches/deepmerge@4.3.1.patch` are applied. The patch rejects the `__proto__` key when copying either merge input, including the CommonJS and UMD builds. Its regression test covers the reported prototype-poisoning behavior.

The registry still reports [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) against the upstream deepmerge version, which has no published fixed release. The local patch does not suppress that advisory. Keep the patch until a reviewed upstream release replaces it.
