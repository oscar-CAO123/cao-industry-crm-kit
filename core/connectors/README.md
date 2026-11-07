# Helper layer

Three layers, the same as the CAO CRM.

1. **Helpers** (this folder): one per app, built from the app's API docs and from code CAO already runs in production. A helper only talks to its app. It never decides anything.
2. **Workflow scripts**: deterministic scripts that do one job, such as chase unpaid invoices or log missed calls, using only the helpers.
3. **Skills**: instructions an agent follows, which call the workflow scripts.

The shell CRM imports the same helpers.

## Rules every helper follows

All network calls go through `core/lib/http.ts`, which enforces them:

- https only, to the hosts the app declares. Keys go in headers, never in a URL.
- Redirects are refused, except file downloads, which drop the key when they leave the app's hosts.
- Anything that changes data needs `KIT_ALLOW_WRITES=1`. Without it the call stops before it is sent and says what it would have done.
- Emails are drafts only. There is no send function. Invoices and agreements are drafts by default.
- Errors give the status, never the response body. Logs never print keys, queries or bodies.
- Rotating tokens live in a token store outside the repo (`~/.cao-kit-tokens`, or the shell CRM's store).

## Where the code came from

Each helper's header names the CAO CRM file each function was ported from, at commit 28aa5d91. Functions written from vendor docs instead are marked NEW: they have not run in production yet.

## Status

`code-built` means the code exists and passes tests against a fake network. It has not been run against a real account, so it is not "supported" yet. That needs `sandbox-tested` or `live-tested`.

Run the tests with `npm test`. Node 22.18 or later runs the TypeScript directly, with no install.
