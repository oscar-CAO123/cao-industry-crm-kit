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

test("pinned Shopify SDK binds documents to mapped operations", async () => {
  const { shopify } = await import("../core/sdk/vendor/shopify.ts");
  const { load } = await import("../core/sdk/call.ts");
  hits=[]; delete process.env.KIT_ALLOW_WRITES; process.env.SHOPIFY_SHOP="testshop"; process.env.SHOPIFY_ACCESS_TOKEN="test-shopify-token";
  const ops=[...load("shopify").ops.values()];
  const q=ops.find((o: any)=>o.method==="QUERY" && o.kind==="read");
  const m=ops.find((o: any)=>o.method==="MUTATION" && o.kind==="write");
  await assert.rejects(shopify(m.id,{document:`mutation { ${m.path} { __typename } }`}), /write blocked/i);
  await assert.rejects(shopify(q.id,{document:`mutation { ${m.path} { __typename } }`}), /expected|query|unexpected/i);
  assert.equal(hits.length,0);
  await shopify(q.id,{server:{shop:"attacker"},document:`query { ${q.path} { __typename } }`});
  assert.equal(hits.length,1);
  assert.equal(new URL(hits[0].url).hostname,"testshop.myshopify.com");
  assert.equal(hits[0].headers.get("x-shopify-access-token"),"test-shopify-token");
  assert.deepEqual(bypass,[]);
});
