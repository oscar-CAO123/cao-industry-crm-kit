import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { search, createDraft } from "../core/connectors/google-workspace/gmail.ts";
import { listContacts } from "../core/connectors/xero/client.ts";
import { login } from "../core/connectors/bullhorn/client.ts";
import { listLeadForms } from "../core/connectors/meta-ads/client.ts";
import { sendMessage } from "../core/connectors/telegram/client.ts";

process.env.COMPOSIO_API_KEY = "test-key";
for (const id of ["GOOGLE_WORKSPACE", "XERO"]) {
  process.env[`KIT_${id}_CONNECTION`] = "composio";
  process.env[`KIT_${id}_COMPOSIO_ACCOUNT_ID`] = `account_${id}`;
  process.env[`KIT_${id}_COMPOSIO_USER_ID`] = `user_${id}`;
}
process.env.KIT_GOOGLE_WORKSPACE_COMPOSIO_MAILBOX = "user@example.com";
process.env.XERO_TENANT_ID = "tenant-1";
after(() => { setTransport(null); for (const key of Object.keys(process.env)) if (key === "COMPOSIO_API_KEY" || key === "XERO_TENANT_ID" || key.startsWith("KIT_GOOGLE_WORKSPACE_") || key.startsWith("KIT_XERO_") || key === "KIT_ALLOW_WRITES" || key === "KIT_BULLHORN_CONNECTION" || key === "KIT_TELEGRAM_CONNECTION") delete process.env[key]; });

test("workflow helpers use managed credentials, respect mailbox and write approval", async () => {
  let requests: any[] = [];
  setTransport({ log() {}, fetch: async (url, init) => {
    assert.equal(url, "https://backend.composio.dev/api/v3.1/tools/execute/proxy");
    const request = JSON.parse(init!.body as string); requests.push(request);
    if (request.endpoint.includes("gmail/v1/users/me/messages")) return Response.json({ status: 200, data: { messages: [{ id: "m1", threadId: "t1" }] } });
    if (request.endpoint.includes("/drafts")) return Response.json({ status: 200, data: { id: "d1", message: { threadId: "t1" } } });
    if (request.endpoint.includes("Contacts")) return Response.json({ status: 200, data: { Contacts: [] } });
    throw new Error("unexpected endpoint");
  } });
  assert.deepEqual(await search("user@example.com", "subject:test"), [{ id: "m1", threadId: "t1" }]);
  await assert.rejects(search("other@example.com", "test"), /mailbox does not match/);
  await assert.rejects(createDraft("user@example.com", { to: "to@example.com", subject: "test", text: "test" }), /write blocked/);
  assert.equal(requests.length, 1);
  process.env.KIT_ALLOW_WRITES = "1";
  await createDraft("user@example.com", { to: "to@example.com", subject: "test", text: "test" });
  await listContacts();
  assert.equal(requests.length, 3);
  assert.ok(requests[2].parameters.some((p: any) => p.name.toLowerCase() === "xero-tenant-id" && p.value === "tenant-1"));
});

test("session-bound and token-in-path helpers refuse managed mode", async () => {
  process.env.KIT_BULLHORN_CONNECTION = "composio";
  process.env.KIT_TELEGRAM_CONNECTION = "composio";
  await assert.rejects(login(), /session bootstrap/);
  await assert.rejects(sendMessage("1", "hello"), /bot token/);
});


test("Meta page credentials use a separately pinned managed account", async () => {
  process.env.KIT_META_ADS_CONNECTION = "composio";
  await assert.rejects(listLeadForms("123"), /separate meta-page/);
  process.env.KIT_META_PAGE_CONNECTION = "composio";
  process.env.KIT_META_PAGE_COMPOSIO_ACCOUNT_ID = "page_account";
  process.env.KIT_META_PAGE_COMPOSIO_USER_ID = "page_user";
  setTransport({ log() {}, fetch: async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    assert.equal(request.connected_account_id, "page_account");
    return Response.json({ status: 200, data: { data: [] } });
  } });
  assert.deepEqual(await listLeadForms("123"), []);
  for (const key of ["KIT_META_ADS_CONNECTION", "KIT_META_PAGE_CONNECTION", "KIT_META_PAGE_COMPOSIO_ACCOUNT_ID", "KIT_META_PAGE_COMPOSIO_USER_ID"]) delete process.env[key];
});
