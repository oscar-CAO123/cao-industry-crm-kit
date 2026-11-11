# Composio managed connections

Composio is an optional authentication and transport route alongside the direct vendor route. The kit uses Composio's official account-specific proxy HTTP API, the same capability exposed by `composio.tools.proxyExecute()` in its TypeScript SDK. It does not install the Composio SDK or an MCP server. Existing workflows, mapped operations, vendor SDK wrappers, approval logic and account restrictions remain in the kit.

## Configuration

Set these through the deployment's secret environment, using the existing 1Password launcher if desired:

```text
KIT_<PLATFORM>_CONNECTION=composio
KIT_<PLATFORM>_COMPOSIO_ACCOUNT_ID=<connected-account-id>
KIT_<PLATFORM>_COMPOSIO_USER_ID=<user-id>
COMPOSIO_API_KEY=<project-key>
```

Use the platform ID in uppercase with hyphens replaced by underscores. Leave CONNECTION unset or set it to `direct` for existing vendor authentication. Other values are refused. Each deployment pins the connected account and user; operation arguments cannot choose them. Candidates create and authorize their own connected accounts, enable proxy execution for the project key, and verify that the connected toolkit supports their endpoints and scopes. The kit neither provisions accounts nor reads their vendor credentials in managed mode.

Google SDK and connector calls share `GOOGLE_WORKSPACE`. Configure `KIT_GOOGLE_WORKSPACE_COMPOSIO_MAILBOX` for the connected mailbox. Google helper calls must select that mailbox. Xero still requires `XERO_TENANT_ID`; account, project, regional host and company settings remain required wherever the direct route pins them. Meta page leads use a separate `META_PAGE` managed connection; an ads connection alone does not select a page account.

## Coverage and boundaries

Mapped calls and the wired native SDK wrappers route through the same proxy transport, as do the executable connector helpers. The local workflow adapters already use these entry points. The kit validates vendor hosts, account selectors, allowed headers and write permissions before calling Composio; proxy errors never trigger a direct-vendor fallback. A write still needs the workflow's approval step and deployment write permission. `KIT_ALLOW_WRITES=1` alone is not human approval.

Ordinary bearer, API-header, Basic and reviewed OAuth routes are covered. Unsupported platform mappings, account-host rewrites in unwired native SDKs, body-key authentication, custom signing, token-in-path protocols and unreviewed authentication headers remain refused. Bullhorn and Telegram helpers explicitly refuse managed mode. Microsoft Advertising native SDK calls remain refused pending request-body scope validation. These are explicit limitations, not claims that Composio supports every catalogue platform.

Form, raw and encoded multipart uploads use the documented `binary_body.base64` field, retaining the mapped content type. Requests are limited to 10 MiB before base64 encoding. Credential fields in JSON, forms and multipart fields are refused; opaque file bytes stay unchanged. Endpoints that require caller-supplied authentication fields must use the direct route. Dropbox mapped content operations use their validated argument header and binary body; existing unsupported native SDK content routes remain refused.

Binary responses are downloaded only when binary mode is requested and `COMPOSIO_DOWNLOAD_HOSTS` explicitly lists the verified public storage hostname(s) used by that deployment. Downloads use HTTPS, receive no project or vendor credentials, refuse redirects, and retain the 50 MiB response limit. Do not add an arbitrary hostname supplied by an untrusted response to this configuration.

## SDK and MCP documentation

The [official tool API overview](https://docs.composio.dev/reference/api-reference/tools) documents the SDK and HTTP forms of proxy execution. The [proxy API reference](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteProxy) defines the account/user fields, headers, binary uploads and response envelope used here. [Session proxy execution](https://docs.composio.dev/docs/extending-sessions/proxy-execute) is a different account-selection interface, based on a session and toolkit.

Composio's [MCP documentation](https://docs.composio.dev/docs/single-toolkit-mcp) covers connecting an agent to Composio tools. Directly attaching that external MCP server would create a separate execution path, outside the kit's local workflow approvals. This kit does not configure that bypass or claim its approval rules cover an external MCP client. An agent using the kit should continue through the existing workflow and SDK entry points.

Tests use the actual pinned vendor SDKs and a fake network. No live Composio account, OAuth consent or vendor execution has been verified.
