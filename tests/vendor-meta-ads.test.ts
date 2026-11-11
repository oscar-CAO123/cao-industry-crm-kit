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

test("pinned Meta SDK gates writes and refuses alternate tokens", async () => {
 const { metaAds } = await import("../core/sdk/vendor/meta-ads.ts");
 const { vendorRequire } = await import("../core/sdk/vendor/load.ts");
 hits=[]; delete process.env.KIT_ALLOW_WRITES; process.env.META_ADS_TOKEN="test-meta-token";
 process.env.META_GRAPH_VERSION=vendorRequire("meta-ads")("facebook-nodejs-business-sdk").FacebookAdsApi.VERSION;
 const { api }=metaAds();
 await assert.rejects(api.call("POST",["act_123","campaigns"],{name:"Example"}), (e: any) => e.name === "FacebookRequestError");
 const { sendPrepared } = await import("../core/sdk/call.ts");
 await assert.rejects(sendPrepared("meta-ads",{method:"POST",url:`https://graph.facebook.com/${process.env.META_GRAPH_VERSION}/act_123/campaigns`,headers:{}}), /write blocked/i);
 process.env.KIT_ALLOW_WRITES="1";
 await assert.rejects(api.call("GET",`https://graph.facebook.com/${process.env.META_GRAPH_VERSION}/123?access_token=other`), (e: any) => e.name === "FacebookRequestError");
 await assert.rejects(api.call("POST",["act_123","campaigns"],{access_token:"other"}), (e: any) => e.name === "FacebookRequestError");
 await assert.rejects(api.call("POST",["act_123","campaigns"],{nested:{access_token:"other"}}), (e: any) => e.name === "FacebookRequestError");
 await assert.rejects(api.call("POST",["act_123","campaigns"],"access_token=other"), (e: any) => e.name === "FacebookRequestError");
 await assert.rejects(api.call("POST",["act_123","campaigns"],new FormData()), (e: any) => e.name === "FacebookRequestError");
 await assert.rejects(api.call("POST",["act_123","campaigns"],new Blob(["access_token=other"])), (e: any) => e.name === "FacebookRequestError");
 assert.equal(hits.length,0); await api.call("GET",["123"]);
 assert.equal(hits.length,1); assert.equal(hits[0].headers.get("authorization"),"Bearer test-meta-token"); assert.ok(!hits[0].url.includes("access_token")); assert.deepEqual(bypass,[]);
});
