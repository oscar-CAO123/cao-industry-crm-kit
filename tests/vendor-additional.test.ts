import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { setTransport } from "../core/lib/http.ts";

const bypass: string[] = [];
for (const [mod, fns] of [[http,["request","get"]],[https,["request","get"]],[http2,["connect"]],[net,["connect","createConnection"]],[tls,["connect"]]] as const) for (const f of fns) (mod as any)[f] = () => { bypass.push(f); throw new Error("network bypass"); };
(globalThis as any).fetch = () => { bypass.push("fetch"); throw new Error("network bypass"); };
let hits: { url: string; headers: Headers }[] = [];
setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => { hits.push({url:String(url), headers:new Headers(init.headers)}); return Response.json({ok:true,entries:[],has_more:false}); }) as any });
process.env.SLACK_BOT_TOKEN = "test-slack-token";
process.env.DROPBOX_ACCESS_TOKEN = "test-dropbox-token";

test("pinned Pylon SDK calls use kit auth", async () => {
  const { pylon } = await import("../core/sdk/vendor/additional-clients.ts");
  hits=[]; delete process.env.KIT_ALLOW_WRITES; process.env.PYLON_API_TOKEN="test-pylon-token";
  await assert.rejects(pylon().accounts.create({ name: "Example" }), /write blocked/i);
  assert.equal(hits.length, 0);
  await pylon().accounts.list();
  assert.equal(hits.length,1);
  assert.equal(hits[0].headers.get("authorization"),"Bearer test-pylon-token");
  assert.deepEqual(bypass,[]);
});
test("pinned Microsoft Graph SDK calls use kit auth", async () => {
  const { microsoft365 } = await import("../core/sdk/vendor/additional-clients.ts");
  hits=[]; delete process.env.KIT_ALLOW_WRITES; process.env.M365_ACCESS_TOKEN="test-m365-token";
  await assert.rejects(microsoft365().api("/admin").patch({}), /write blocked/i);
  assert.equal(hits.length, 0);
  await microsoft365().api("/admin").get();
  assert.equal(hits.length,1);
  assert.equal(hits[0].headers.get("authorization"),"Bearer test-m365-token");
  assert.deepEqual(bypass,[]);
});
