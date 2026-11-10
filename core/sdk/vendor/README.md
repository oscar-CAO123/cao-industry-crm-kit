# Official SDK adapters

Workflows already call the shared connection layer through their platform adapters. Official SDK adapters are an optional interface to that same gate. Installing a pinned SDK does not create a new workflow or prove a client account works.

Nine pinned SDKs have adapters: Stripe, Square, Xero, and Google's Admin Directory, Calendar, Docs, Drive, Gmail and Sheets clients. Other pointers in `vendor-sdks/index.json` retain their current status. Installed packages must match their audited lockfile. No package versions changed in this update.

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
