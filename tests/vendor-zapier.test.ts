import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { setTransport } from "../core/lib/http.ts";
import { zapier, zapierFetch } from "../core/sdk/vendor/zapier.ts";
const bypass: string[] = [];
for (const mod of [http, https]) for (const fn of ["request", "get"]) (mod as any)[fn] = () => { bypass.push(fn); throw Error("network bypass"); };
(globalThis as any).fetch = () => { bypass.push("fetch"); throw Error("network bypass"); };
const hits: { url: string; headers: Headers }[] = [];
setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => { hits.push({ url: String(url), headers: new Headers(init.headers) }); return Response.json(String(url).includes("profile/") ? { id: 7, first_name: "Test", last_name: "User", email: "test@example.com", email_confirmed: true, timezone: "UTC" } : { results: [], count: 0, next: null }); }) as any });
test("Zapier SDK profile is bound to the kit token and other routes are refused", async () => {
  process.env.ZAPIER_ACCESS_TOKEN = "test-zapier-token"; delete process.env.KIT_ALLOW_WRITES;
  const client = zapier();
  const result = await client.getProfile();
  assert.equal(result.data.id, "7");
  assert.equal(hits.length, 1);
  assert.equal(new URL(hits[0].url).hostname, "sdkapi.zapier.com");
  assert.equal(hits[0].headers.get("authorization"), "Bearer test-zapier-token");
  const apps = await client.listApps();
  assert.deepEqual(apps.data, []);
  assert.equal(hits.length, 2);
  assert.equal((client as any).runAction, undefined);
  assert.equal((client as any).fetch, undefined);
  assert.deepEqual(bypass, []);
});

test("SDK relay writes are refused before reaching the network", async () => {
  const { createZapierSdk } = (await import("../core/sdk/vendor/load.ts")).vendorRequire("zapier")("@zapier/zapier-sdk");
  const sdk = createZapierSdk({ credentials: "placeholder", fetch: zapierFetch(), eventEmission: { enabled: false } });
  const before = hits.length;
  process.env.KIT_ALLOW_WRITES = "1";
  await assert.rejects(sdk.fetch("https://example.com/private", { method: "POST", body: "{}" }), /refused/i);
  assert.equal(hits.length, before);
  delete process.env.KIT_ALLOW_WRITES;
});

test("Zapier SDK profile routes through the configured Composio account", async () => {
  process.env.KIT_ZAPIER_CONNECTION = "composio";
  process.env.KIT_ZAPIER_COMPOSIO_ACCOUNT_ID = "ca_zapier";
  process.env.KIT_ZAPIER_COMPOSIO_USER_ID = "user_zapier";
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  let requests = 0;
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => {
    requests++;
    assert.equal(String(url), "https://backend.composio.dev/api/v3.1/tools/execute/proxy");
    const body = JSON.parse(init.body);
    assert.equal(body.connected_account_id, "ca_zapier");
    assert.equal(body.user_id, "user_zapier");
    assert.equal(body.endpoint, "https://sdkapi.zapier.com/api/v0/sdk/zapier/api/v4/profile/");
    assert.equal(body.method, "GET");
    return Response.json({ status: 200, data: { id: 7, first_name: "Test", last_name: "User", email: "test@example.com", email_confirmed: true, timezone: "UTC" }, headers: { "content-type": "application/json" } });
  }) as any });
  try { assert.equal((await zapier().getProfile()).data.id, "7"); assert.equal(requests, 1); }
  finally { delete process.env.KIT_ZAPIER_CONNECTION; delete process.env.KIT_ZAPIER_COMPOSIO_ACCOUNT_ID; delete process.env.KIT_ZAPIER_COMPOSIO_USER_ID; delete process.env.COMPOSIO_API_KEY; }
});
