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

test("pinned Asana SDK uses kit auth and gates writes", async () => {
 const { asana } = await import("../core/sdk/vendor/asana.ts");
 hits=[]; delete process.env.KIT_ALLOW_WRITES; process.env.ASANA_ACCESS_TOKEN="test-asana-token";
 const api=asana("TasksApi"); await assert.rejects(api.createTask({data:{name:"Example"}}), /write blocked/i);
 assert.equal(hits.length,0); await api.getTask("123");
 assert.equal(hits.length,1); assert.equal(hits[0].headers.get("authorization"),"Bearer test-asana-token"); assert.deepEqual(bypass,[]);
});
test("pinned Mailchimp SDK uses configured account region and kit auth", async () => {
 const { mailchimp } = await import("../core/sdk/vendor/mailchimp.ts");
 hits=[]; delete process.env.KIT_ALLOW_WRITES; process.env.MAILCHIMP_API_KEY="test-mailchimp-key"; process.env.MAILCHIMP_DC="us1";
 const api=mailchimp(); await assert.rejects(api.lists.createList({name:"Example"}), /write blocked/i); assert.equal(hits.length,0); await api.ping.get(); assert.equal(hits.length,1);
 assert.equal(new URL(hits[0].url).hostname,"us1.api.mailchimp.com"); assert.equal(hits[0].headers.get("authorization"),"Bearer test-mailchimp-key"); assert.deepEqual(bypass,[]);
});
