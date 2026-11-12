import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { setTransport } from "../core/lib/http.ts";
import { slack, dropbox } from "../core/sdk/vendor/fetch-clients.ts";

const bypass: string[] = [];
for (const [mod, fns] of [[http,["request","get"]],[https,["request","get"]],[http2,["connect"]],[net,["connect","createConnection"]],[tls,["connect"]]] as const) for (const f of fns) (mod as any)[f] = () => { bypass.push(f); throw new Error("network bypass"); };
(globalThis as any).fetch = () => { bypass.push("fetch"); throw new Error("network bypass"); };
let hits: { url: string; headers: Headers }[] = [];
setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => { hits.push({url:String(url), headers:new Headers(init.headers)}); return Response.json({ok:true,entries:[],has_more:false}); }) as any });
process.env.SLACK_BOT_TOKEN = "test-slack-token";
process.env.DROPBOX_ACCESS_TOKEN = "test-dropbox-token";

test("pinned Slack SDK blocks writes unless permitted and uses kit token", async () => {
  delete process.env.KIT_ALLOW_WRITES;
  await assert.rejects(slack().chat.postMessage({channel:"C123", text:"hello"}));
  assert.equal(hits.length,0);
  process.env.KIT_ALLOW_WRITES="1";
  await slack().chat.postMessage({channel:"C123", text:"hello"});
  assert.equal(hits.length,1);
  assert.equal(hits[0].headers.get("authorization"),"Bearer test-slack-token");
  assert.equal(new URL(hits[0].url).hostname,"slack.com");
  assert.deepEqual(bypass,[]);
});
test("pinned Dropbox SDK routes mapped calls through the gate", async () => {
  hits=[]; delete process.env.KIT_ALLOW_WRITES;
  await assert.rejects(dropbox().filesDeleteV2({path:"/test.txt"}));
  assert.equal(hits.length,0);
  await dropbox().filesListFolder({path:""});
  assert.equal(hits.length,1);
  assert.equal(hits[0].headers.get("authorization"),"Bearer test-dropbox-token");
  assert.deepEqual(bypass,[]);
});
