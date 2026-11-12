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

test("pinned Plaid SDK uses both kit keys and gates POST", async () => {
  const { plaid } = await import("../core/sdk/vendor/plaid.ts");
  hits=[]; delete process.env.KIT_ALLOW_WRITES; process.env.PLAID_SECRET="test-secret"; process.env.PLAID_CLIENT_ID="test-id";
  const client=plaid();
  await assert.rejects(client.accounts.get({access_token:"test-item"}), /write blocked/i);
  assert.equal(hits.length,0);
  process.env.KIT_ALLOW_WRITES="1";
  await client.accounts.get({access_token:"test-item"}, {version:"2023-01-01",clientId:"wrong-client"});
  assert.equal(hits.length,1);
  assert.equal(hits[0].headers.get("plaid-secret"),"test-secret");
  assert.equal(hits[0].headers.get("plaid-client-id"),"test-id");
  assert.equal(hits[0].headers.get("plaid-version"),"2020-09-14");
  assert.deepEqual(bypass,[]);
});
