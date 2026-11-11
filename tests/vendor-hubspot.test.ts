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

test("legacy HubSpot SDK uses the kit gate", async () => {
  const { hubspotLegacy } = await import("../core/sdk/vendor/hubspot-legacy.ts");
  hits=[]; delete process.env.KIT_ALLOW_WRITES; process.env.HUBSPOT_ACCESS_TOKEN="test-hubspot-token";
  await assert.rejects(hubspotLegacy("crm/companies", "BasicApi").create({ properties: { name: "Example" } }), /write blocked/i);
  assert.equal(hits.length, 0);
  await hubspotLegacy("crm/companies", "BasicApi").getPage(1);
  assert.equal(hits.length,1);
  assert.equal(hits[0].headers.get("authorization"),"Bearer test-hubspot-token");
  assert.deepEqual(bypass,[]);
});
