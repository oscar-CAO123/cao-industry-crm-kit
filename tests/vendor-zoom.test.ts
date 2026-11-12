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
setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => { if (new URL(String(url)).hostname === "zoom.us") return Response.json({ access_token: "test-zoom-token", expires_in: 3600 }); hits.push({url:String(url), headers:new Headers(init.headers)}); return Response.json({ok:true,entries:[],has_more:false}); }) as any });
process.env.SLACK_BOT_TOKEN = "test-slack-token";
process.env.DROPBOX_ACCESS_TOKEN = "test-dropbox-token";

test("pinned Zoom SDK gates writes and uses kit OAuth", async () => {
 const { zoom } = await import("../core/sdk/vendor/zoom.ts");
 const { clearTokenCache } = await import("../core/connectors/zoom/client.ts");
 hits=[]; delete process.env.KIT_ALLOW_WRITES; Object.assign(process.env,{ZOOM_ACCOUNT_ID:"test-account",ZOOM_CLIENT_ID:"test-client",ZOOM_CLIENT_SECRET:"test-secret"}); clearTokenCache();
 const api=zoom("meetings"); await assert.rejects(api.meetings.deleteMeeting({path:{meetingId:123}}), /write blocked/i);
 assert.equal(hits.length,0); process.env.KIT_ALLOW_WRITES="1"; await api.meetings.getMeeting({path:{meetingId:123}});
 assert.equal(hits.length,1); assert.equal(hits[0].headers.get("authorization"),"Bearer test-zoom-token"); assert.deepEqual(bypass,[]);
});
