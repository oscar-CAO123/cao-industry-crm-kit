// Sign-in, keys and hosts for the approved-scope tools (9 Nov 2026), from each vendor's own reference pages
// (endpoint-map/extracted/<tool>.json, each grounded by its reader's check). All are proof "docs": unproven until a sandbox run.
// Shapes match the platform table in tools/sdk-generate.mjs.
// A DNS name whose last label is letters: never a bare IP address (a private or metadata address).
const HOST = "([a-z0-9-]+\\.)+[a-z]{2,63}";
const TOKEN = "token exchange not built yet: supply an access token";
const GOOGLE_KEYS = ["GOOGLE_MAILBOX", "GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET"];
const d = (name, auth, more = {}) => ({ name, auth, proof: "docs", ...more });

export const APPROVED = {
  "acuity": d("Acuity Scheduling", { type: "basic", user: "ACUITY_USER_ID", pass: "ACUITY_API_KEY" }),
  "paperform": d("Paperform", { type: "bearer", env: "PAPERFORM_API_KEY" }),
  "looker-studio": d("Looker Studio", { type: "custom", provider: "google" },
    { defaultScope: "https://www.googleapis.com/auth/datastudio", keys: GOOGLE_KEYS }),
  // Self-hosted or cloud: the client's own n8n host, from the secret store only.
  "n8n": d("n8n", { type: "header", header: "X-N8N-API-KEY", env: "N8N_API_KEY" },
    { server: "https://{host}/api/v1", forceServer: true, hostFromEnv: true, serverVars: { host: { env: "N8N_HOST", pattern: HOST, envOnly: true, example: "n8n.client.example.org" } } }),
  // Production or the developer sandbox host, both from Intuit's reference; the company id (realmID) is pinned to the client's own.
  "quickbooks": d("QuickBooks Online (Accounting API)", { type: "bearer", env: "QUICKBOOKS_ACCESS_TOKEN", note: TOKEN },
    { server: "https://{host}", forceServer: true,
      serverVars: { host: { env: "QUICKBOOKS_HOST", default: "quickbooks.api.intuit.com", pattern: "(sandbox-)?quickbooks\\.api\\.intuit\\.com" } },
      pinned: { realmID: { allow: [], env: "QUICKBOOKS_REALM_ID", fill: "$env" } },
      keys: ["QUICKBOOKS_ACCESS_TOKEN", "QUICKBOOKS_REALM_ID", "QUICKBOOKS_HOST (optional: sandbox-quickbooks.api.intuit.com for the sandbox)"] }),
  // Auth v2 (Bearer) is current; the legacy /api/1.x Data API routes take "JWT <token>" (set per route in sdk-generate.mjs).
  "time-doctor": d("Time Doctor", { type: "bearer", env: "TIMEDOCTOR_ACCESS_TOKEN", note: TOKEN }),
  "procore": d("Procore", { type: "bearer", env: "PROCORE_ACCESS_TOKEN", note: TOKEN, extraHeaders: { "Procore-Company-Id": "PROCORE_COMPANY_ID" } },
    // company_id (path, query or body on 209 routes) is pinned to the client's own, like QuickBooks' realmID (pen test, 9 Nov).
    { pinned: { company_id: { allow: [], env: "PROCORE_COMPANY_ID", fill: "$env" } },
      gaps: ["Sandbox host not read from Procore's pages: only the production host api.procore.com is mapped"] }),
};
