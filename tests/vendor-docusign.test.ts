import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { setTransport } from "../core/lib/http.ts";

const hits: { url: string; headers: Headers }[] = [];
let host = "https://au.docusign.net";
setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => {
  const u = String(url); hits.push({ url: u, headers: new Headers(init.headers) });
  if (u.endsWith("/oauth/token")) return Response.json({ access_token: "test-token", expires_in: 3600 });
  if (u.endsWith("/oauth/userinfo")) return Response.json({ accounts: [{ account_id: "account-1", base_uri: host }] });
  return Response.json({ envelopeId: "env-1", status: "sent" });
}) as any });
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
Object.assign(process.env, { DOCUSIGN_ACCOUNT_ID: "account-1", DOCUSIGN_INTEGRATION_KEY: "integration", DOCUSIGN_USER_ID: "user", DOCUSIGN_PRIVATE_KEY: privateKey });

test("DocuSign SDK pins account, blocks writes, and resolves its account host", async () => {
 const { docusign } = await import("../core/sdk/vendor/docusign.ts");
 const { clearTokenCache } = await import("../core/connectors/docusign/client.ts");
 const api = docusign("EnvelopesApi");
 delete process.env.KIT_ALLOW_WRITES; hits.length = 0; clearTokenCache();
 await assert.rejects(api.createEnvelope("account-1", { envelopeDefinition: { status: "created" } }), /write blocked/i);
 await assert.rejects(api.getEnvelope("other-account", "env-1"), /client's own/i);
 assert.equal(hits.length, 0);
 await api.getEnvelope("account-1", "env-1");
 assert.equal(hits.at(-1)?.url, "https://au.docusign.net/restapi/v2.1/accounts/account-1/envelopes/env-1");
 assert.equal(hits.at(-1)?.headers.get("authorization"), "Bearer test-token");
 process.env.KIT_ALLOW_WRITES = "1";
 await api.createEnvelope("account-1", { envelopeDefinition: { status: "created" } });
 assert.equal(hits.at(-1)?.url, "https://au.docusign.net/restapi/v2.1/accounts/account-1/envelopes");
 host = "https://evil.example"; clearTokenCache();
 await assert.rejects(api.getEnvelope("account-1", "env-1"), /base URL refused/);
 delete process.env.KIT_ALLOW_WRITES;
});
