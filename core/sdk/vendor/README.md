# Official SDK adapters

Workflows already call the shared connection layer through their platform adapters. Official SDK adapters are an optional interface to that same gate. Installing a pinned SDK does not create a new workflow or prove a client account works.

Thirty-two pinned SDKs have adapters: Stripe, Square, Xero, Slack, Dropbox, Google Analytics, Pylon, Microsoft Graph, GoHighLevel, Make, Pipedrive, WooCommerce, Jotform, Plaid, HubSpot alpha, Airtable, Shopify, PandaDoc, Asana, Mailchimp, Twilio, Zoom, Klaviyo, Meta Ads, BigQuery dataset listing, HubSpot’s generated resource APIs, and Google's Admin Directory, Calendar, Docs, Drive, Gmail and Sheets clients. Other pointers in `vendor-sdks/index.json` retain their current status. Installed packages must match their audited lockfile. No package versions changed in this update.

Install only the package needed, for example `node tools/sdk-install.mjs googleapis-drive`. Then import `googleWorkspace` from `core/sdk/vendor/google-workspace.ts` and call `googleWorkspace("drive").files.list({pageSize: 10})`. Services are `admin`, `calendar`, `docs`, `drive`, `gmail` and `sheets`. Admin uses Directory v1. The kit owns authentication, mailbox restrictions and network transport; SDK HTTP/2 is refused. Use the normal kit Google connection setup. Candidates supply their business credentials through 1Password and grant the required scopes.

Every SDK request must match a mapped operation. Writes require `KIT_ALLOW_WRITES=1`; workflow approval is still handled by the workflow runtime. This flag alone is not a human approval. These adapters were tested with the actual pinned packages and a fake network, not live client accounts. Unsupported endpoints, streaming paths and alternate SDK options do not gain support from the presence of a wrapper.

## File uploads

`callOperation` accepts `multipart` for operations mapped as multipart/form-data. Supply explicit text or file parts, using the vendor's documented field names:

```ts
const input = {
  multipart: [
    { name: "description", value: "Approved attachment" },
    { name: "file", file: {
      filename: "attachment.txt", contentType: "text/plain", base64: "SGVsbG8="
    } }
  ]
};
```

Queue this JSON-safe input through the existing workflow approval runtime before a write. File bytes are captured in the queued input, so replacing a local file cannot change an approved upload. Preview output contains filenames, MIME types and sizes, not file bytes or text values. The encoded request is limited to 50 MiB and 100 parts. Uploads still need the mapped operation's authentication and write permission. Multipart support supplies encoding only; vendor-specific required fields, access restrictions and upload semantics must come from that vendor's documentation. Raw and resumable upload protocols remain separate.

For Slack and Dropbox, import `slack` or `dropbox` from `core/sdk/vendor/fetch-clients.ts`. The kit supplies credentials and transport. Operations classified as writes require `KIT_ALLOW_WRITES=1`.

For Google Analytics, import `googleAnalytics` from `core/sdk/vendor/google-analytics.ts`. The client uses the REST fallback and the kit gate.

Pylon and Microsoft Graph are available from `core/sdk/vendor/additional-clients.ts`; HubSpot generated resource APIs use `hubspotLegacy` from `core/sdk/vendor/hubspot-legacy.ts`. The HubSpot OAuth client is excluded.

GoHighLevel, Make and Pipedrive have adapters in their respective files under `core/sdk/vendor/`. Make uses the configured `MAKE_ZONE`.

WooCommerce and Jotform use their respective adapters in `core/sdk/vendor/`. WooCommerce uses the hostname in `WOOCOMMERCE_SITE`.

Plaid and HubSpot alpha have adapters in `core/sdk/vendor/`. Plaid uses API version 2020-09-14, matching the pinned operation map. The HubSpot package remains an alpha release.

Airtable, Shopify and PandaDoc have adapters in `core/sdk/vendor/`. Shopify accepts only a mapped operation and its validated GraphQL document. Airtable refuses a previously loaded SDK that did not use the kit gate.

Asana and Mailchimp use their adapters in `core/sdk/vendor/`. Mailchimp uses the account region in `MAILCHIMP_DC`. SDK streaming uploads are refused.

The Twilio adapter is restricted to the v2010 API for the account in `TWILIO_ACCOUNT_SID`; other Twilio products are refused.

The remaining SDK pointers are not wired. Onfleet imports node-fetch directly; Zapier uses SDK proxy routes absent from the operation map; DocuSign requires a validated account-host rewrite; monday uses an app-host message bridge and needs operation-bound GraphQL routing. See `vendor-sdks/index.json` for the per-package notes.

The Zoom adapter uses kit-managed OAuth. Some mapped Zoom GET operations are conservatively classified as writes and require the write flag.

Klaviyo uses a per-session gated transport.

The BigQuery adapter only lists dataset IDs in `GOOGLE_CLOUD_PROJECT`. It does not expose the SDK client, queries, writes, Arrow or storage streams. Meta Ads uses its adapter in `core/sdk/vendor/meta-ads.ts`, with plain-data request bodies and kit-owned credentials.
