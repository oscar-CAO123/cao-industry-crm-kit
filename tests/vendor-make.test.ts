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

test("pinned Make SDK uses the configured zone and kit token", async () => {
  const { make } = await import("../core/sdk/vendor/make.ts");
  hits=[]; delete process.env.KIT_ALLOW_WRITES; process.env.MAKE_API_TOKEN="test-make-token"; process.env.MAKE_ZONE="eu1";
  await assert.rejects(make().scenarios.delete(123), /write blocked/i);
  assert.equal(hits.length, 0);
  await make().users.me();
  assert.equal(hits.length,1);
  assert.equal(hits[0].headers.get("authorization"),"Token test-make-token");
  assert.equal(new URL(hits[0].url).hostname,"eu1.make.com");
  assert.deepEqual(bypass,[]);
});
