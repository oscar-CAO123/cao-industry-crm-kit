import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { callOperation, sendPrepared } from "../core/sdk/call.ts";
import { stripe } from "../core/sdk/vendor/stripe.ts";
import { slack } from "../core/sdk/vendor/fetch-clients.ts";

const names = ["STRIPE", "SLACK", "GOOGLE_WORKSPACE", "GOOGLE_ANALYTICS", "XERO", "ZOOM", "DROPBOX", "DOCUSIGN"];
process.env.COMPOSIO_API_KEY = "project-test";
for (const name of names) {
  process.env[`KIT_${name}_CONNECTION`] = "composio";
  process.env[`KIT_${name}_COMPOSIO_ACCOUNT_ID`] = `ca_${name}`;
  process.env[`KIT_${name}_COMPOSIO_USER_ID`] = `user_${name}`;
}
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SLACK_BOT_TOKEN;
process.env.GOOGLE_MAILBOX = "legacy@example.com";
process.env.GOOGLE_ALLOWED_MAILBOXES = "other@example.com";
process.env.KIT_GOOGLE_WORKSPACE_COMPOSIO_MAILBOX = "connected@example.com";
process.env.XERO_TENANT_ID = "tenant-pinned";
let hits: any[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("unexpected network bypass"); }) as typeof fetch;
setTransport({ log() {}, fetch: async (url, init) => {
  assert.equal(String(url), "https://backend.composio.dev/api/v3.1/tools/execute/proxy");
  const body = JSON.parse(String(init!.body));
  hits.push(body);
  const data = body.endpoint.includes("stripe.com") ? { object: "list", data: [], has_more: false, url: "/v1/customers" } : { ok: true, items: [] };
  return Response.json({ status: 200, data, headers: { "content-type": "application/json" } });
} });
after(() => { globalThis.fetch = originalFetch; setTransport(null); delete process.env.COMPOSIO_API_KEY; delete process.env.KIT_ALLOW_WRITES; delete process.env.GOOGLE_MAILBOX; delete process.env.GOOGLE_ALLOWED_MAILBOXES; delete process.env.KIT_GOOGLE_WORKSPACE_COMPOSIO_MAILBOX; delete process.env.XERO_TENANT_ID; for (const name of names) for (const suffix of ["CONNECTION", "COMPOSIO_ACCOUNT_ID", "COMPOSIO_USER_ID"]) delete process.env[`KIT_${name}_${suffix}`]; });

test("mapped Google OAuth uses the connected account without vendor credentials", async () => {
  hits = [];
  await callOperation("google-workspace", "calendar.settings.list");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].connected_account_id, "ca_GOOGLE_WORKSPACE");
  assert.match(hits[0].endpoint, /^https:\/\/www.googleapis.com\/calendar\/v3\/users\/me\/settings/);
  await assert.rejects(callOperation("google-workspace", "calendar.settings.list", { as: "other@example.com" }), /not supported/);
  await assert.rejects(callOperation("google-workspace", "gmail.users.getProfile", { params: { userId: "other@example.com" } }), /client.s own/);
  await assert.rejects(sendPrepared("google-workspace", { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/other@example.com/profile", headers: {} }), /client.s own/);
  await callOperation("google-workspace", "gmail.users.getProfile", { params: { userId: "connected@example.com" } });
  assert.equal(hits.length, 2);
});

test("actual Stripe SDK uses one proxy and refuses unapproved writes", async () => {
  hits = [];
  await stripe().customers.list({ limit: 2 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].connected_account_id, "ca_STRIPE");
  assert.match(hits[0].endpoint, /^https:\/\/api.stripe.com\/v1\/customers/);
  assert.doesNotMatch(JSON.stringify(hits[0]), /kit-placeholder-not-a-key/);
  await assert.rejects(stripe().customers.create({ email: "test@example.com" }));
  assert.equal(hits.length, 1);
});

test("actual Slack SDK is gated and uses one proxy for an approved write", async () => {
  hits = [];
  await assert.rejects(slack().chat.postMessage({ channel: "C123", text: "hello" }));
  assert.equal(hits.length, 0);
  process.env.KIT_ALLOW_WRITES = "1";
  try {
    await slack().chat.postMessage({ channel: "C123", text: "hello" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].connected_account_id, "ca_SLACK");
    assert.match(hits[0].endpoint, /^https:\/\/slack.com\/api\/chat.postMessage/);
    assert.doesNotMatch(JSON.stringify(hits[0]), /kit-placeholder-not-a-key/);
  } finally { delete process.env.KIT_ALLOW_WRITES; }
});

test("unmapped, scope and unsupported auth paths refuse without fallback", async () => {
  hits = [];
  await assert.rejects(sendPrepared("stripe", { method: "GET", url: "https://api.stripe.com/v1/not-real", headers: {} }), /mapped endpoint/);
  await assert.rejects(sendPrepared("microsoft-advertising", { method: "GET", url: "https://example.com", headers: {} }), /scope/);
  await assert.rejects(callOperation("docusign", "esignature.ServiceInformation_GetServiceInformation"), /not supported/);
  assert.equal(hits.length, 0);
});


test("Xero and Zoom prepared OAuth calls use managed authentication", async () => {
  hits = [];
  await sendPrepared("xero", { method: "GET", url: "https://api.xero.com/api.xro/2.0/Contacts", headers: { "Xero-Tenant-Id": "other-tenant", Authorization: "Bearer placeholder" } });
  assert.equal(hits[0].connected_account_id, "ca_XERO");
  assert.deepEqual(hits[0].parameters.find((p: any) => p.name.toLowerCase() === "xero-tenant-id").value, "tenant-pinned");
  await sendPrepared("zoom", { method: "GET", url: "https://api.zoom.us/v2/meetings/123/recordings", headers: { Authorization: "Bearer placeholder" } });
  assert.equal(hits[1].connected_account_id, "ca_ZOOM");
  assert.doesNotMatch(JSON.stringify(hits), /placeholder/);
});

test("mapped Dropbox content preserves arguments and binary bytes", async () => {
  hits = [];
  process.env.KIT_ALLOW_WRITES = "1";
  try {
    await callOperation("dropbox", "files.upload", { params: { path: "/test.txt" }, contentBase64: "aGVsbG8=" });
    assert.equal(hits[0].binary_body.base64, "aGVsbG8=");
    assert.equal(JSON.parse(hits[0].parameters.find((p: any) => p.name.toLowerCase() === "dropbox-api-arg").value).path, "/test.txt");
    const reply = await callOperation<ArrayBuffer>("dropbox", "files.download", { params: { path: "/test.txt" } });
    assert.ok(reply.data instanceof ArrayBuffer);
    assert.equal(hits.length, 2);
  } finally { delete process.env.KIT_ALLOW_WRITES; }
});
