---
name: agent-sdk
description: Call any endpoint of a connected app (Xero, Google, Microsoft 365, HubSpot, Zoom, Meta and 26 more) through the kit's gated SDK. Use when a workflow or script needs an app's API.
---

# Agent SDK

Every public endpoint of 116 apps is mapped in `core/sdk/platforms/<app>/`, from the vendor's own spec, official SDK or docs pages. Find the call, preview it, then run it.

```
node tools/sdk.mjs platforms                          # apps, endpoint counts, the keys each needs
node tools/sdk.mjs search xero overdue invoices       # find the endpoint
node tools/sdk.mjs describe xero accounting.getInvoices
node tools/sdk.mjs plan xero accounting.getInvoices --params '{"Statuses":"AUTHORISED"}'
node tools/sdk.mjs call xero accounting.getInvoices --params '{"Statuses":"AUTHORISED"}' --live
```

In a script, import the app's named functions: `import { accountingGetInvoices } from "../core/sdk/platforms/xero/index.ts"`.

- Keys come from the client's secret store under the names `platforms` lists. Never put a key in a param, a script or a log.
- Reads run as they are. Anything that changes data needs `KIT_ALLOW_WRITES=1`, set by a person for that run.
- Prefer a hand-written helper in `core/connectors/<app>/` when one exists for the job: those are proven in production.
- Status is honest: `spec` and `docs-read` endpoints have run only against a fake network until a sandbox run says otherwise. Shopify lists names only; pass a full GraphQL `--document`.
- Rebuild after the endpoint map changes: `node tools/sdk-generate.mjs <endpoints dir>`, then `npm test`.
