import test from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
const hits: any[] = [];
Object.assign(process.env, { KIT_DOCUSIGN_CONNECTION: "composio", KIT_DOCUSIGN_COMPOSIO_ACCOUNT_ID: "connection", KIT_DOCUSIGN_COMPOSIO_USER_ID: "user", COMPOSIO_API_KEY: "project", DOCUSIGN_ACCOUNT_ID: "account-1" });
for (const k of ["DOCUSIGN_INTEGRATION_KEY", "DOCUSIGN_USER_ID", "DOCUSIGN_PRIVATE_KEY", "KIT_ALLOW_WRITES"]) delete process.env[k];
(globalThis as any).fetch = () => { throw new Error("network bypass"); };
setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => {
  assert.equal(String(url), "https://backend.composio.dev/api/v3.1/tools/execute/proxy");
  const req = JSON.parse(String(init.body)); hits.push(req);
  const data = req.endpoint.endsWith("/oauth/userinfo") ? { accounts: [{ account_id: "account-1", base_uri: "https://au.docusign.net" }] } : { envelopeId: "env-1", status: "sent" };
  return Response.json({ status: 200, data, headers: { "content-type": "application/json" } });
}) as any });
test("managed DocuSign SDK resolves the pinned account without vendor credentials", async () => {
 const { docusign } = await import("../core/sdk/vendor/docusign.ts");
 const api = docusign("EnvelopesApi");
 await assert.rejects(api.createEnvelope("account-1", { envelopeDefinition: { status: "created" } }), /write blocked/i);
 await assert.rejects(api.getEnvelope("other", "env-1"), /client.s own/i);
 assert.equal(hits.length, 0);
 await api.getEnvelope("account-1", "env-1");
 assert.equal(hits.length, 2);
 assert.match(hits[0].endpoint, /^https:\/\/account\.docusign\.com\/oauth\/userinfo/);
 assert.equal(hits[1].endpoint, "https://au.docusign.net/restapi/v2.1/accounts/account-1/envelopes/env-1");
 assert.doesNotMatch(JSON.stringify(hits), /kit-placeholder-not-a-key|Authorization/i);
 process.env.KIT_ALLOW_WRITES = "1";
 await api.createEnvelope("account-1", { envelopeDefinition: { status: "created" } });
 assert.equal(hits.at(-1).endpoint, "https://au.docusign.net/restapi/v2.1/accounts/account-1/envelopes");
 delete process.env.KIT_ALLOW_WRITES;
});
