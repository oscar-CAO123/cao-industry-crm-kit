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

test("pinned Twilio SDK fixes account and gates writes", async () => {
 const { twilio } = await import("../core/sdk/vendor/twilio.ts");
 hits=[]; delete process.env.KIT_ALLOW_WRITES; process.env.TWILIO_ACCOUNT_SID="AC"+"a".repeat(32); process.env.TWILIO_AUTH_TOKEN="test-token";
 const api=twilio(); await assert.rejects(api.messages.create({to:"+10000000000",from:"+10000000001",body:"test"}), /write blocked/i);
 await assert.rejects(api.api.v2010.accounts("AC"+"b".repeat(32)).fetch(), /configured account/i);
 assert.equal(hits.length,0); await api.api.v2010.accounts(process.env.TWILIO_ACCOUNT_SID).addresses.list({limit:1});
 assert.equal(hits.length,1); assert.equal(hits[0].headers.get("authorization"),"Basic "+Buffer.from(process.env.TWILIO_ACCOUNT_SID+":test-token").toString("base64")); assert.deepEqual(bypass,[]);
});
